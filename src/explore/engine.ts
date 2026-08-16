/**
 * M3: exploration engine. DFS over a frontier of (state, untried action)
 * pairs, replaying from root to backtrack (see docs/poc-plan.md's "Replay
 * from root for backtracking"). Everything produced here has provenance
 * `default-props` — a single fixed prop assignment for the whole run, no
 * prop generation (that is M4).
 */
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { settle, type SettleOptions, type CommitDriver, type ObservedCommit } from "../settle.js";
import type { ComponentSnapshot } from "../fiber/index.js";
import { AdaptiveAbstraction, type AdaptiveOptions, type StateId } from "../abstraction/adaptive.js";
import { IDENTITY_KINDS, resolveHookNames } from "../abstraction/index.js";
import { computeDomFingerprint } from "../abstraction/domFingerprint.js";
import { discoverActions, type DiscoverActionsOptions, type DiscoveredAction } from "./actions.js";
import type { ActionRef, Edge, ExplorationResult, ReplayDivergence, StateNode } from "./graph.js";
import { DEFAULT_BUDGET, type Budget } from "../budget.js";

export interface ExploreOptions {
  componentName: string;
  /** Renders the root element for a given props object. Typically `(props) => <MyComponent {...props} />`. */
  render: (props: Record<string, unknown>) => ReactElement;
  /** The single, fixed props assignment used for this run (default-props provenance). */
  props: Record<string, unknown>;
  /** Enables ts-morph-based hook naming for the abstraction; see src/abstraction/index.ts. */
  sourcePath?: string;
  /** Forwarded to discoverActions for text-field fill values. */
  fillPools?: DiscoverActionsOptions["fillPools"];
  /** Function-typed props to expose as invokeProp actions. If omitted, function-valued entries of `props` are used automatically. */
  invokableProps?: Record<string, (...args: unknown[]) => unknown>;
  budget?: Budget;
  /** Forwarded to AdaptiveAbstraction (custom override, literalDomainLimit, ignoreHooks, domCorrelation). */
  abstraction?: Omit<AdaptiveOptions, "componentName" | "sourcePath">;
  /** Forwarded to settle(). Defaults to { useFakeTimers: false }. */
  settle?: Partial<SettleOptions>;
}

function actionRefOf(action: DiscoveredAction): ActionRef {
  return {
    id: action.id,
    kind: action.kind,
    label: action.label,
    ...(action.value !== undefined ? { value: action.value } : {}),
    ...(action.optionValue !== undefined ? { optionValue: action.optionValue } : {}),
    ...(action.propName !== undefined ? { propName: action.propName } : {}),
  };
}

function extractFields(snapshot: ComponentSnapshot, sourcePath: string | undefined, componentName: string): Record<string, unknown> {
  const identityHooks = snapshot.hooks.filter((h) => IDENTITY_KINDS.has(h.kind));
  const warnings: string[] = [];
  const names = resolveHookNames(identityHooks, { componentName, sourcePath }, warnings);
  const fields: Record<string, unknown> = {};
  identityHooks.forEach((hook, idx) => {
    const name = names[idx];
    if (name) fields[name] = hook.value;
  });
  return fields;
}

interface WorkItem {
  fromId: StateId;
  action: ActionRef;
  isRetry: boolean;
}

/**
 * Runs a full DFS exploration of one component under one fixed props
 * assignment. See docs/m3-exploration-report.md for measured results
 * against the benchmark corpus.
 */
export async function exploreComponent(options: ExploreOptions): Promise<ExplorationResult> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  // "next-timer" jumps straight to whichever fake timer is due next instead
  // of stepping through timerStepMs at a time. It observes exactly the same
  // sequence of commits as fixed stepping (nothing about which commits fire
  // depends on how many virtual milliseconds were skipped to get there), so
  // it costs nothing in fidelity here -- unlike test/settle/settle.test.tsx's
  // direct settle() tests, which deliberately exercise fixed-step iteration
  // budgeting and are unaffected by this engine-level default. See
  // docs/m3-5-refinement-report.md, "Problem 2".
  const settleOpts: SettleOptions = { useFakeTimers: false, timerAdvance: "next-timer", ...options.settle };
  // performance.now() rather than Date.now(): vi.useFakeTimers() mocks
  // Date, so under fake timers Date.now() reflects virtual time, which
  // balloons every time a fake timer is advanced (e.g. a 300ms debounce
  // firing repeatedly), not real wall-clock time. That conflation was the
  // actual cause of DebouncedSearch appearing to cost 30+ real seconds in
  // the M3 report -- see docs/m3-5-refinement-report.md, "Problem 2".
  // performance.now() is not in vi.useFakeTimers()'s default fake list, so
  // it stays tied to the real clock regardless of fake timer state.
  const startTime = performance.now();

  const invokableProps =
    options.invokableProps ??
    Object.fromEntries(
      Object.entries(options.props).filter(([, v]) => typeof v === "function"),
    ) as Record<string, (...args: unknown[]) => unknown>;

  const abstraction = new AdaptiveAbstraction({
    componentName: options.componentName,
    sourcePath: options.sourcePath,
    ...options.abstraction,
  });

  // --- graph state -----------------------------------------------------
  const states = new Map<StateId, StateNode>();
  const edges: Edge[] = [];
  const triedActions = new Map<StateId, Set<string>>();
  const actionsByState = new Map<StateId, DiscoveredAction[]>();
  const destinations = new Map<string, Set<string>>(); // `${fromId}::${actionId}` -> observed dest ids
  const retriedStates = new Set<StateId>();
  const unavailableActions: ExplorationResult["unavailableActions"] = [];
  const findings: ExplorationResult["findings"] = { unstable: [], nonDeterministic: [], replayDivergences: [] };
  const rekeyMerges: ExplorationResult["rekeyMerges"] = [];
  const aliasMap = new Map<StateId, StateId>();
  // Ids ever observed as the point where a settle() call actually stopped
  // (the last commit in some chain), as opposed to merely passed through en
  // route. See StateNode.transient's doc comment for why this distinction
  // drives whether a state's actions get seeded.
  const settledStateIds = new Set<StateId>();

  function resolveAlias(id: StateId): StateId {
    let cur = id;
    while (aliasMap.has(cur)) cur = aliasMap.get(cur)!;
    return cur;
  }

  abstraction.onRekey((merges) => {
    for (const merge of merges) {
      rekeyMerges.push({ from: [...merge.from], to: merge.to });
      const survivorId = merge.to;
      let survivor = states.get(survivorId);
      for (const fromId of merge.from) {
        aliasMap.set(fromId, survivorId);
        const loser = states.get(fromId);
        if (loser) {
          if (!survivor) {
            // Survivor's node hadn't been created directly (only reached via merge); adopt the loser's identity.
            survivor = { ...loser, id: survivorId };
            states.set(survivorId, survivor);
          } else if (loser.witness.actions.length < survivor.witness.actions.length) {
            // Keep the shortest/earliest witness.
            survivor.witness = loser.witness;
          }
          states.delete(fromId);
        }
        // If the loser had ever been observed as a genuine settled
        // destination (not just an intermediate commit), that fact belongs
        // to the survivor now too. Note: this only flips the `transient`
        // flag; it does not retroactively seed the survivor's actions, since
        // no live container for the survivor is available inside this
        // callback. A survivor that becomes non-transient only via a rekey
        // (rather than via its own settle() landing) can therefore end up
        // with `transient: false` but no seeded actions until some other
        // path visits it directly -- a known, narrow gap, not a silent
        // correctness issue (the state and its transient flag are still
        // reported correctly either way).
        if (settledStateIds.has(fromId)) {
          settledStateIds.add(survivorId);
          settledStateIds.delete(fromId);
          if (survivor) survivor.transient = false;
        }
        // Redirect edges.
        for (const edge of edges) {
          if (edge.from === fromId) edge.from = survivorId;
          if (edge.to === fromId) edge.to = survivorId;
        }
        // Union tried-action bookkeeping.
        const loserTried = triedActions.get(fromId);
        if (loserTried) {
          const survivorTried = triedActions.get(survivorId) ?? new Set<string>();
          for (const a of loserTried) survivorTried.add(a);
          triedActions.set(survivorId, survivorTried);
          triedActions.delete(fromId);
        }
        const loserActions = actionsByState.get(fromId);
        if (loserActions && !actionsByState.has(survivorId)) {
          actionsByState.set(survivorId, loserActions);
        }
        actionsByState.delete(fromId);
        // Redirect destination-tracking keys.
        for (const [key, set] of destinations) {
          if (key.startsWith(`${fromId}::`)) {
            const rest = key.slice(fromId.length);
            const newKey = `${survivorId}${rest}`;
            const existing = destinations.get(newKey) ?? new Set<string>();
            for (const d of set) existing.add(d === fromId ? survivorId : d);
            destinations.set(newKey, existing);
            destinations.delete(key);
          } else if (set.has(fromId)) {
            set.delete(fromId);
            set.add(survivorId);
          }
        }
        // Redirect frontier entries in place.
        for (const item of workStack) {
          if (item.fromId === fromId) item.fromId = survivorId;
        }
        if (retriedStates.has(fromId)) {
          retriedStates.add(survivorId);
          retriedStates.delete(fromId);
        }
      }
    }
  });

  let actionsUsed = 0;
  let sessionId = 0;
  let liveContainer: HTMLElement | undefined;
  let liveUnmount: (() => void) | undefined;

  function cleanupLive(): void {
    if (liveUnmount) {
      liveUnmount();
      liveUnmount = undefined;
    }
    if (liveContainer?.parentNode) liveContainer.parentNode.removeChild(liveContainer);
    liveContainer = undefined;
  }

  // Settle options used during replay-from-root: the destination is already
  // known (it's what replay is trying to *verify*, not discover), so replay
  // can jump straight to whichever fake timer is due next instead of
  // stepping through timerStepMs at a time. See docs/m3-5-refinement-report.md,
  // "Problem 2" for the measured effect.
  const replaySettleOpts: SettleOptions = { ...settleOpts, timerAdvance: "next-timer" };

  /**
   * Mounts a fresh instance, settles to quiescence, and observes only the
   * *final* snapshot -- used during replay-from-root, where every
   * intermediate commit along the way is already a known state and only the
   * final destination needs verifying. See mountFreshChain for the
   * full-fidelity version used for the one real root mount.
   */
  async function mountFreshFast(): Promise<{ container: HTMLElement; id: StateId; unstable: boolean; fields: Record<string, unknown> }> {
    cleanupLive();
    const container = document.createElement("div");
    document.body.appendChild(container);
    liveContainer = container;
    sessionId += 1;
    const thisSession = sessionId;
    const { unmount } = render(options.render(options.props), { container });
    liveUnmount = unmount;
    const result = await settle(replaySettleOpts);
    const comp = result.snapshot.components.find((c) => c.componentName === options.componentName);
    if (!comp) {
      throw new Error(`exploreComponent: component "${options.componentName}" not found in mounted tree`);
    }
    const domFingerprint = computeDomFingerprint(container);
    const id = abstraction.observe({ snapshot: comp, props: options.props, domFingerprint, sessionId: thisSession });
    return { container, id: resolveAlias(id), unstable: !result.settled, fields: extractFields(comp, options.sourcePath, options.componentName) };
  }

  /** Performs one discovered action, settles, and observes only the final snapshot -- used during replay-from-root (see mountFreshFast). */
  async function performAndObserveFast(
    container: HTMLElement,
    action: DiscoveredAction,
  ): Promise<{ id: StateId; unstable: boolean; fields: Record<string, unknown> }> {
    try {
      action.perform();
    } catch {
      // A discovered action (most commonly an auto-derived invokeProp for a
      // function prop that turns out to require arguments the explorer has
      // no way to synthesise, e.g. FetchList's fetchItems or
      // DebouncedSearch's query -- both function props, but data sources
      // rather than user-facing callbacks) can throw when invoked blind.
      // Swallow it and settle on whatever the DOM/fiber state is now,
      // rather than crashing the whole exploration run over one bad action.
    }
    actionsUsed++;
    const result = await settle(replaySettleOpts);
    const comp = result.snapshot.components.find((c) => c.componentName === options.componentName);
    const domFingerprint = computeDomFingerprint(container);
    if (!comp) {
      // Component no longer present (e.g. replaced by a status/terminal render with no matching name,
      // such as Wizard's/ValidatedForm's terminal <p role="status"> screens, which unmount the
      // original function component entirely). Record a best-effort id from an empty snapshot.
      const id = abstraction.observe({
        snapshot: { componentName: options.componentName, path: options.componentName, hooks: [] },
        props: options.props,
        domFingerprint,
        sessionId,
      });
      return { id: resolveAlias(id), unstable: !result.settled, fields: {} };
    }
    const id = abstraction.observe({ snapshot: comp, props: options.props, domFingerprint, sessionId });
    return { id: resolveAlias(id), unstable: !result.settled, fields: extractFields(comp, options.sourcePath, options.componentName) };
  }

  interface ChainStep {
    id: StateId;
    fields: Record<string, unknown>;
    domFingerprint: string | undefined;
    driver: CommitDriver;
  }

  /**
   * Runs `settleOptions` against `container` and observes *every* commit
   * along the way (not just the final one), via settle()'s onCommit hook --
   * called synchronously as each commit lands, while the DOM still reflects
   * that exact commit (see settle.ts's onCommit doc comment for why this
   * can't be done after settle() returns).
   */
  async function collectChain(
    settleOptions: SettleOptions,
    container: HTMLElement,
    thisSessionId: number,
  ): Promise<{ steps: ChainStep[]; unstable: boolean }> {
    const steps: ChainStep[] = [];
    const result = await settle({
      ...settleOptions,
      onCommit: (commit: ObservedCommit) => {
        const comp = commit.snapshot.components.find((c) => c.componentName === options.componentName);
        const domFingerprint = computeDomFingerprint(container);
        if (comp) {
          const id = abstraction.observe({ snapshot: comp, props: options.props, domFingerprint, sessionId: thisSessionId });
          steps.push({ id, fields: extractFields(comp, options.sourcePath, options.componentName), domFingerprint, driver: commit.driver });
        } else {
          const id = abstraction.observe({
            snapshot: { componentName: options.componentName, path: options.componentName, hooks: [] },
            props: options.props,
            domFingerprint,
            sessionId: thisSessionId,
          });
          steps.push({ id, fields: {}, domFingerprint, driver: commit.driver });
        }
      },
    });
    return { steps, unstable: !result.settled };
  }

  function budgetExhausted(): boolean {
    if (actionsUsed >= budget.maxActions) return true;
    if (states.size >= budget.maxStates) return true;
    if (performance.now() - startTime >= budget.maxWallClockMs) return true;
    return false;
  }

  /**
   * Turns a `collectChain` result into graph states/edges: the first step is
   * reached via `action` (or is the root, if `fromId`/`action` are
   * undefined); every subsequent step is an automatic transition from the
   * previous one. Only the *last* step is treated as a genuine, settled,
   * replayable state (its actions get seeded); every earlier step is
   * `transient` unless some other chain has already settled there for real
   * -- see StateNode.transient's doc comment and
   * docs/m3-5-refinement-report.md's "transient-state rule".
   */
  function processChain(params: {
    steps: ChainStep[];
    fromId: StateId | undefined;
    action: ActionRef | undefined;
    priorActions: ActionRef[];
    unstable: boolean;
    container: HTMLElement;
  }): { finalId: StateId; chainEdges: Edge[] } {
    const { steps, fromId, action, priorActions, unstable, container } = params;
    let prevId = fromId;
    let finalId: StateId = fromId as StateId;
    const chainEdges: Edge[] = [];

    steps.forEach((step, i) => {
      const stepId = resolveAlias(step.id);
      const isFinal = i === steps.length - 1;

      if (prevId !== undefined) {
        const kind: "user" | "auto" = i === 0 ? "user" : "auto";
        const edge: Edge = {
          from: prevId,
          to: stepId,
          kind,
          provenance: "default-props",
          stable: !unstable,
          ...(kind === "user" ? { action: action! } : { driver: step.driver === "timer" ? ("timer" as const) : ("microtask" as const) }),
        };
        edges.push(edge);
        chainEdges.push(edge);
        if (!edge.stable) findings.unstable.push(edge);
      }

      if (!states.has(stepId)) {
        const node: StateNode = {
          id: stepId,
          key: stepId,
          fields: step.fields,
          provenance: "default-props",
          witness: {
            props: options.props,
            actions: action ? [...priorActions, action] : [...priorActions],
            ...(isFinal
              ? {}
              : {
                  note:
                    "reached only via an automatic transition (timer/microtask) after the witness actions; " +
                    "settle() runs to quiescence, so this intermediate state is not independently reachable by replay",
                }),
          },
          domFingerprint: step.domFingerprint,
          transient: !isFinal,
        };
        states.set(stepId, node);
      }
      const node = states.get(stepId)!;

      if (isFinal) {
        settledStateIds.add(stepId);
        if (node.transient) node.transient = false;
        if (!budgetExhausted()) seedActionsFor(stepId, container);
      } else if (!settledStateIds.has(stepId)) {
        node.transient = true;
      }

      prevId = stepId;
      finalId = stepId;
    });

    return { finalId, chainEdges };
  }

  const workStack: WorkItem[] = [];

  function seedActionsFor(stateId: StateId, container: HTMLElement): void {
    if (actionsByState.has(stateId)) return;
    const { available, unavailable } = discoverActions(container, {
      fillPools: options.fillPools,
      invokableProps,
    });
    actionsByState.set(stateId, available);
    for (const a of unavailable) {
      unavailableActions.push({ state: stateId, action: actionRefOf(a), reason: a.reason });
    }
    const tried = triedActions.get(stateId) ?? new Set<string>();
    triedActions.set(stateId, tried);
    const untried = available.filter((a) => !tried.has(a.id));
    // Push a retry item for one already-tried action first (bottom of stack,
    // processed last), then all untried actions on top. Cheap non-determinism
    // probing per docs/poc-plan.md: re-try at most one already-tried edge per
    // state once, not every edge.
    if (available.length > 0 && !retriedStates.has(stateId)) {
      workStack.push({ fromId: stateId, action: actionRefOf(available[0]!), isRetry: true });
      retriedStates.add(stateId);
    }
    for (const a of untried) {
      workStack.push({ fromId: stateId, action: actionRefOf(a), isRetry: false });
    }
  }

  // --- root mount --------------------------------------------------------
  cleanupLive();
  const rootContainer = document.createElement("div");
  document.body.appendChild(rootContainer);
  liveContainer = rootContainer;
  sessionId += 1;
  const rootSession = sessionId;
  const { unmount: rootUnmount } = render(options.render(options.props), { container: rootContainer });
  liveUnmount = rootUnmount;
  const rootChain = await collectChain(settleOpts, rootContainer, rootSession);
  if (rootChain.steps.length === 0) {
    throw new Error(`exploreComponent: component "${options.componentName}" not found in mounted tree`);
  }
  const { finalId: rootFinalId } = processChain({
    steps: rootChain.steps,
    fromId: undefined,
    action: undefined,
    priorActions: [],
    unstable: rootChain.unstable,
    container: rootContainer,
  });
  const root = { id: rootFinalId, container: rootContainer };
  // root's actions were already seeded by processChain (its final chain step
  // seeds unconditionally), so no explicit seedActionsFor(root...) call is
  // needed here -- unlike before this refinement, where the root was always
  // a single settled observation and had to be seeded explicitly.

  while (workStack.length > 0) {
    if (budgetExhausted()) break;
    const item = workStack.pop()!;
    const fromId = resolveAlias(item.fromId);
    const tried = triedActions.get(fromId) ?? new Set<string>();
    if (!item.isRetry && tried.has(item.action.id)) continue; // already covered (e.g. via rekey merge)
    const fromState = states.get(fromId);
    if (!fromState) continue; // merged away with nothing to reattach to; skip defensively

    if (budgetExhausted()) break;

    // Replay from root to reach fromState (empty witness for the root state
    // itself, so this degrades to a single fresh mount there).
    const container = await replayForState(fromState);
    if (!container) continue;

    // Find the action fresh in the replayed DOM.
    const { available } = discoverActions(container, { fillPools: options.fillPools, invokableProps });
    const liveAction = available.find((a) => a.id === item.action.id);
    if (!liveAction) {
      unavailableActions.push({ state: fromId, action: item.action, reason: "unavailable at replay time" });
      tried.add(item.action.id);
      triedActions.set(fromId, tried);
      continue;
    }

    // Perform the action and observe every commit settle() sees along the
    // way, not just the final one (M3.5's fix for the "loading"/"waiting"
    // structural-invisibility problem -- see docs/m3-5-refinement-report.md).
    try {
      liveAction.perform();
    } catch {
      // See the identical catch in performAndObserveFast: an auto-derived
      // invokeProp action can throw when invoked blind; swallow it and
      // settle on whatever state results.
    }
    actionsUsed++;
    const chainResult = await collectChain(settleOpts, container, sessionId);
    const unstable = chainResult.unstable;

    // A rekey can fire synchronously inside collectChain's observe() calls
    // (e.g. this very transition's destination pushes a hook's domain past
    // its literal limit and demotes it, retroactively merging *this* fromId
    // into some other survivor). Re-resolve fromId after the call returns,
    // not before, so the edge never references an id that was just merged
    // away.
    const resolvedFromId = resolveAlias(fromId);
    const resolvedFromState = states.get(resolvedFromId) ?? fromState;
    const resolvedTried = triedActions.get(resolvedFromId) ?? tried;
    resolvedTried.add(item.action.id);
    triedActions.set(resolvedFromId, resolvedTried);

    const { finalId: destId, chainEdges } = processChain({
      steps: chainResult.steps,
      fromId: resolvedFromId,
      action: item.action,
      priorActions: resolvedFromState.witness.actions,
      unstable,
      container: liveContainer!,
    });

    // Determinism check: tracked against the *final* (settled) destination,
    // since that's the only state further actions can be seeded from and
    // the only one replay-from-root can reliably verify landing back on.
    const destKey = `${resolvedFromId}::${item.action.id}`;
    const seen = destinations.get(destKey) ?? new Set<string>();
    const isNewDivergence = seen.size > 0 && !seen.has(destId);
    seen.add(destId);
    destinations.set(destKey, seen);

    if (isNewDivergence || seen.size > 1) {
      // Attach the finding to the edge that actually lands on destId: the
      // sole "user" edge if the chain was a single commit, otherwise the
      // last "auto" edge in the chain.
      const landingEdge = chainEdges[chainEdges.length - 1];
      if (landingEdge) {
        landingEdge.nonDeterministic = { observedDestinations: [...seen] };
        findings.nonDeterministic.push(landingEdge);
      }
    }
  }

  cleanupLive();

  const elapsedMs = performance.now() - startTime;
  const exhausted = budgetExhausted() && workStack.length > 0;
  const unexploredFrontier = workStack.map((item) => ({ state: resolveAlias(item.fromId), action: item.action }));

  return {
    component: options.componentName,
    graph: { states: [...states.values()], edges },
    unavailableActions,
    findings,
    budget: { actionsUsed, statesFound: states.size, elapsedMs, exhausted },
    unexploredFrontier,
    rekeyMerges,
    domPruneReport: abstraction.getDomPruneReport(),
  };

  /**
   * Replays from root to reach `state` by re-executing its witness action
   * sequence, verifying the final id matches. On any mismatch or
   * unavailable action mid-replay, records a divergence and returns
   * undefined.
   */
  async function replayForState(state: StateNode): Promise<HTMLElement | undefined> {
    const mounted = await mountFreshFast();
    let container = mounted.container;
    let currentId = mounted.id;

    for (const step of state.witness.actions) {
      const { available } = discoverActions(container, { fillPools: options.fillPools, invokableProps });
      const found = available.find((a) => a.id === step.id);
      if (!found) {
        findings.replayDivergences.push({
          state: state.id,
          expectedId: state.id,
          actualId: "<action unavailable during replay>",
          witness: state.witness.actions,
        });
        return undefined;
      }
      const { id } = await performAndObserveFast(container, found);
      currentId = id;
      container = liveContainer!;
    }

    // Resolve state.id through the alias map before comparing: a rekey can
    // fire mid-replay (e.g. inside mountFresh's own observe() call, if this
    // replay's root observation happens to be the one that pushes a hook's
    // domain past its limit and demotes it), merging the very state this
    // replay is trying to reach into a different survivor id. `state` is a
    // snapshot reference captured before the replay started and is not
    // mutated by the merge, so comparing against its raw `.id` would produce
    // a false divergence for what is actually a successful replay.
    const expectedId = resolveAlias(state.id);
    if (currentId !== expectedId) {
      findings.replayDivergences.push({
        state: state.id,
        expectedId,
        actualId: currentId,
        witness: state.witness.actions,
      });
      return undefined;
    }
    return container;
  }
}
