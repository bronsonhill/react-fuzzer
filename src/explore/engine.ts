/**
 * M3: exploration engine. DFS over a frontier of (state, untried action)
 * pairs, replaying from root to backtrack (see docs/poc-plan.md's "Replay
 * from root for backtracking"). Everything produced here has provenance
 * `default-props` — a single fixed prop assignment for the whole run, no
 * prop generation (that is M4).
 */
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { settle, type SettleOptions } from "../settle.js";
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
  const settleOpts: SettleOptions = { useFakeTimers: false, ...options.settle };
  const startTime = Date.now();

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

  /** Mounts a fresh instance with the fixed props, settles, and observes -> resolved StateId. */
  async function mountFresh(): Promise<{ container: HTMLElement; id: StateId; unstable: boolean; fields: Record<string, unknown> }> {
    cleanupLive();
    const container = document.createElement("div");
    document.body.appendChild(container);
    liveContainer = container;
    sessionId += 1;
    const thisSession = sessionId;
    const { unmount } = render(options.render(options.props), { container });
    liveUnmount = unmount;
    const result = await settle(settleOpts);
    const comp = result.snapshot.components.find((c) => c.componentName === options.componentName);
    if (!comp) {
      throw new Error(`exploreComponent: component "${options.componentName}" not found in mounted tree`);
    }
    const domFingerprint = computeDomFingerprint(container);
    const id = abstraction.observe({ snapshot: comp, props: options.props, domFingerprint, sessionId: thisSession });
    return { container, id: resolveAlias(id), unstable: !result.settled, fields: extractFields(comp, options.sourcePath, options.componentName) };
  }

  /** Performs one discovered action, settles, and observes -> resolved StateId (and whether settle was clean). */
  async function performAndObserve(
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
    const result = await settle(settleOpts);
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

  function budgetExhausted(): boolean {
    if (actionsUsed >= budget.maxActions) return true;
    if (states.size >= budget.maxStates) return true;
    if (Date.now() - startTime >= budget.maxWallClockMs) return true;
    return false;
  }

  // --- root mount --------------------------------------------------------
  const root = await mountFresh();
  const rootNode: StateNode = {
    id: root.id,
    key: root.id,
    fields: root.fields,
    provenance: "default-props",
    witness: { props: options.props, actions: [] },
    domFingerprint: computeDomFingerprint(root.container),
  };
  states.set(root.id, rootNode);

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

  seedActionsFor(root.id, root.container);

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

    const { id: rawDestId, unstable, fields: destFields } = await performAndObserve(container, liveAction);
    // A rekey can fire synchronously inside performAndObserve's observe()
    // call (e.g. this very transition's destination pushes a hook's domain
    // past its literal limit and demotes it, retroactively merging *this*
    // fromId into some other survivor). Re-resolve both ids after the call
    // returns, not before, so the edge never references an id that was just
    // merged away.
    const destId = resolveAlias(rawDestId);
    const resolvedFromId = resolveAlias(fromId);
    const resolvedFromState = states.get(resolvedFromId) ?? fromState;
    const resolvedTried = triedActions.get(resolvedFromId) ?? tried;
    resolvedTried.add(item.action.id);
    triedActions.set(resolvedFromId, resolvedTried);

    // Determinism check.
    const destKey = `${resolvedFromId}::${item.action.id}`;
    const seen = destinations.get(destKey) ?? new Set<string>();
    const isNewDivergence = seen.size > 0 && !seen.has(destId);
    seen.add(destId);
    destinations.set(destKey, seen);

    const edge: Edge = {
      from: resolvedFromId,
      to: destId,
      action: item.action,
      provenance: "default-props",
      stable: !unstable,
    };
    if (isNewDivergence || seen.size > 1) {
      edge.nonDeterministic = { observedDestinations: [...seen] };
    }
    edges.push(edge);
    if (!edge.stable) findings.unstable.push(edge);
    if (edge.nonDeterministic) findings.nonDeterministic.push(edge);

    if (!states.has(destId)) {
      const destContainer = liveContainer!;
      const node: StateNode = {
        id: destId,
        key: destId,
        fields: destFields,
        provenance: "default-props",
        witness: { props: options.props, actions: [...resolvedFromState.witness.actions, item.action] },
        domFingerprint: computeDomFingerprint(destContainer),
      };
      states.set(destId, node);
      if (!budgetExhausted()) seedActionsFor(destId, destContainer);
    }
  }

  cleanupLive();

  const elapsedMs = Date.now() - startTime;
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
  };

  /**
   * Replays from root to reach `state` by re-executing its witness action
   * sequence, verifying the final id matches. On any mismatch or
   * unavailable action mid-replay, records a divergence and returns
   * undefined.
   */
  async function replayForState(state: StateNode): Promise<HTMLElement | undefined> {
    const mounted = await mountFresh();
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
      const { id } = await performAndObserve(container, found);
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
