/**
 * M2.5: dynamic state abstraction. M2's canonicalisation (src/abstraction/
 * index.ts) is static — every hook value is bucketed in isolation by its
 * runtime type, so a small discrete union (Wizard's `step`, FetchList's
 * `status`) is flattened to a constant token that carries no information,
 * and getting the intended state count back required a per-component
 * `literalHooks`/`custom` override for five of the seven benchmark
 * components (see docs/m2-abstraction-report.md).
 *
 * `AdaptiveAbstraction` instead learns, per hook, whether its value looks
 * like a small enum (keep verbatim) or free-ranging data (bucket, as M2
 * does) from what is actually observed across a run, and separately learns
 * whether a hook's value ever shows up in the rendered DOM at all (if not,
 * exclude it from identity — see the DOM-correlation pruner below). Both
 * are *dynamic* judgements that can change as more of the component is
 * explored, which is the hard part: a hook can look like a 3-valued enum
 * for the first N observations and then turn out to be free text, and by
 * then some already-issued state ids were built assuming it was an enum.
 * See `onRekey` for how that gets corrected instead of silently producing
 * a wrong graph.
 */
import type { ComponentSnapshot, HookRecord } from "../fiber/index.js";
import { canonicalise, stableStringify, type CanonToken } from "./canonicalise.js";
import { IDENTITY_KINDS, resolveHookNames, type StateKey } from "./index.js";

export type StateId = string;

export interface RekeyMerge {
  /** Previously-issued ids that, after a demotion/prune, denote the same state and have been collapsed into `to`. */
  from: StateId[];
  /** The surviving id (the lowest-numbered of the merged group, so ids stay stable where possible). */
  to: StateId;
}

export interface DomPruneReport {
  hookName: string;
  /** Number of hook-value changes observed with no accompanying DOM change. */
  variedNoDomCount: number;
  /** True if at least one observation showed the hook varying in step with the DOM (disqualifying evidence). */
  everCoVaried: boolean;
  pruned: boolean;
}

export interface DomCorrelationOptions {
  /** Turn the pruner on/off. Default true. */
  enabled?: boolean;
  /**
   * Minimum number of "hook varied, DOM did not" observations required
   * before pruning, and the honesty knob this deliverable calls out: too
   * low, and a hook that happens not to have been exercised through its
   * DOM-visible branch yet gets pruned prematurely (a false positive that
   * hides a real, if not-yet-observed, effect); too high, and a genuinely
   * inert hook (like FetchList's `attempt`) keeps splitting states for
   * longer than necessary before the pruner acts. Default 3.
   */
  minObservations?: number;
}

export interface AdaptiveOptions {
  componentName: string;
  /** Enables ts-morph-based hook naming; see src/abstraction/index.ts. */
  sourcePath?: string;
  /** Hook names excluded from state identity entirely, unconditionally (independent of the DOM pruner). */
  ignoreHooks?: string[];
  /**
   * While a hook's distinct-primitive-value count observed so far is at or
   * below this limit, its value is preserved verbatim (like M2's
   * `literalHooks`, but decided dynamically and for any primitive type, not
   * just strings). Once the count exceeds the limit, the hook is
   * permanently demoted to M2's static bucketing rule.
   *
   * The trade-off: set too high, and a free-text field (email, a search
   * box) looks like an enum for a while, so early exploration treats every
   * distinct string typed so far as its own state — churn, not correctness,
   * since it eventually demotes, but a lot of spurious detail accumulates
   * before it does. Set too low, and a genuine small union with more values
   * than the limit (a 6-valued `phase`) gets demoted and collapses back to
   * M2's behaviour, which is the exact failure this deliverable exists to
   * fix. Default 8, chosen because it comfortably covers every enum-shaped
   * hook in the benchmark corpus (max observed: DebouncedSearch's 6-valued
   * `phase`) while still being small enough to demote Counter's `value`
   * before it would (Counter's `value` only ranges 0-5, so it is *not*
   * demoted at the default — see docs/m2-5-adaptive-report.md for why that
   * is the right call for a bounded counter, and where the line is fuzzy).
   */
  literalDomainLimit?: number;
  domCorrelation?: DomCorrelationOptions;
  /**
   * Full override, exactly like M2's `custom` (src/abstraction/index.ts),
   * including the same props visibility (M2.5 Deliverable C). If it returns
   * a value, that value wins outright and bypasses the adaptive machinery
   * (domain tracking, DOM pruning) for this observation.
   */
  custom?: (snapshot: ComponentSnapshot, props: Record<string, unknown>) => StateKey | undefined;
}

interface HistoryEntry {
  fields: Record<string, unknown>;
  customKey?: string;
  domFingerprint?: string;
  sessionId: string | number;
  stateId: StateId;
}

export interface ObserveInput {
  snapshot: ComponentSnapshot;
  /** Current prop values for this run (M2.5 Deliverable C). Not part of state identity; visible to `custom` only. */
  props?: Record<string, unknown>;
  /** Normalised DOM fingerprint for this commit; see ./domFingerprint.ts. Required for the DOM-correlation pruner to do anything. */
  domFingerprint?: string;
  /**
   * Identifies which mount/replay this observation belongs to. The
   * DOM-correlation pruner only compares *consecutive* observations within
   * the same session, because two observations from different mounts are
   * two unrelated renders — comparing across that boundary would treat
   * "brand new component tree, different everything" as evidence about a
   * single hook's effect on the DOM, which is not what it is. Defaults to a
   * single implicit session (`0`) when omitted; a caller that unmounts and
   * remounts (as replay-from-root, M3, will) must supply a value that
   * changes across the remount.
   */
  sessionId?: string | number;
}

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
}

function domainKey(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return `${typeof value}:${String(value)}`;
}

function literalToken(value: unknown): CanonToken {
  if (value === null) return "null:null";
  if (value === undefined) return "undefined:undefined";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return `lit:${Number.isNaN(value) ? "NaN" : String(value)}`;
  return `lit:${String(value)}`;
}

/**
 * Observes a stream of snapshots for one component instance and assigns
 * each a StateId, adapting its per-hook literal-vs-bucket rule and its
 * DOM-prunable-hook set as it goes. State counts in this tool's budget are
 * small (the plan caps exploration at 50 states), so every `observe()` call
 * re-derives the demoted set, the pruned set, and every previously-issued
 * id from a full pass over history, rather than maintaining them
 * incrementally — simpler to get right, and cheap enough at this scale.
 * See the class doc comment for why a full pass is necessary at all.
 */
export class AdaptiveAbstraction {
  private readonly options: AdaptiveOptions;
  private readonly ignore: Set<string>;
  private readonly literalDomainLimit: number;
  private readonly domEnabled: boolean;
  private readonly domMinObservations: number;

  private history: HistoryEntry[] = [];
  private demotedHooks = new Set<string>();
  private prunedHooks = new Set<string>();
  private lastPruneReport: DomPruneReport[] = [];
  private nextIdNum = 0;
  private warnings: string[] = [];
  private rekeyCallbacks: Array<(merges: RekeyMerge[]) => void> = [];

  constructor(options: AdaptiveOptions) {
    this.options = options;
    this.ignore = new Set(options.ignoreHooks ?? []);
    this.literalDomainLimit = options.literalDomainLimit ?? 8;
    this.domEnabled = options.domCorrelation?.enabled ?? true;
    this.domMinObservations = options.domCorrelation?.minObservations ?? 3;
  }

  /** Registers a callback invoked whenever a demotion or DOM-prune retroactively merges previously-distinct state ids. Returns an unsubscribe function. */
  onRekey(cb: (merges: RekeyMerge[]) => void): () => void {
    this.rekeyCallbacks.push(cb);
    return () => {
      this.rekeyCallbacks = this.rekeyCallbacks.filter((c) => c !== cb);
    };
  }

  getDemotedHooks(): string[] {
    return [...this.demotedHooks].sort();
  }

  /** Report from the most recent recompute: which hooks were evaluated for DOM-correlation pruning, with the evidence counts and the resulting decision. Always report this prominently — see class doc comment on why pruning must never be silent. */
  getDomPruneReport(): DomPruneReport[] {
    return this.lastPruneReport;
  }

  getWarnings(): string[] {
    return this.warnings;
  }

  private freshId(): StateId {
    return `s${this.nextIdNum++}`;
  }

  private extractIdentityFields(snapshot: ComponentSnapshot): Record<string, unknown> {
    const identityHooks: HookRecord[] = snapshot.hooks.filter((h) => IDENTITY_KINDS.has(h.kind));
    const names = resolveHookNames(identityHooks, this.options, this.warnings);
    const fields: Record<string, unknown> = {};
    identityHooks.forEach((hook, idx) => {
      const name = names[idx];
      if (!name) return;
      fields[name] = hook.value;
    });
    return fields;
  }

  /**
   * observe() is the only mutating entry point. It appends the snapshot to
   * history, then unconditionally re-derives demotion, DOM-pruning, and
   * every state id from scratch (see class doc comment for why a full
   * recompute, not an incremental update, is required for correctness).
   * Returns the StateId assigned to this observation, which may equal an
   * earlier id (revisited state) and may itself be the *target* of a merge
   * this call triggers.
   */
  observe(input: ObserveInput): StateId {
    const props = input.props ?? {};
    const custom = this.options.custom?.(input.snapshot, props);
    const fields = this.extractIdentityFields(input.snapshot);

    const entry: HistoryEntry = {
      fields,
      customKey: custom?.key,
      domFingerprint: input.domFingerprint,
      sessionId: input.sessionId ?? 0,
      stateId: "", // assigned below by recompute()
    };
    this.history.push(entry);

    this.recompute();
    return entry.stateId;
  }

  private recompute(): void {
    this.recomputeDemotion();
    this.recomputePruning();
    this.recomputeIdsAndRekey();
  }

  /** Recomputes the permanently-demoted hook set from the full domain observed across history so far. Monotonic: history only grows, so a domain's size only grows, so once a hook demotes it never un-demotes. */
  private recomputeDemotion(): void {
    const domains = new Map<string, Set<string>>();
    for (const entry of this.history) {
      for (const [name, value] of Object.entries(entry.fields)) {
        if (this.ignore.has(name) || !isPrimitive(value)) continue;
        if (!domains.has(name)) domains.set(name, new Set());
        domains.get(name)!.add(domainKey(value));
      }
    }
    for (const [name, values] of domains) {
      if (values.size > this.literalDomainLimit) this.demotedHooks.add(name);
    }
  }

  /**
   * Recomputes the DOM-prunable hook set. Evidence is gathered over
   * consecutive history entries, subject to two guards, both found
   * necessary empirically (see docs/m2-5-adaptive-report.md) rather than
   * anticipated in advance:
   *
   * 1. Only entries from the *same session* (see ObserveInput.sessionId)
   *    are compared. Two consecutive observations that straddle an
   *    unmount/remount boundary are two unrelated renders — every hook
   *    appears to "change" and the DOM always "changes" there, which is not
   *    evidence about any single hook's effect on rendering.
   * 2. Only a transition where *exactly one* identity hook changed value
   *    can produce evidence for that hook, in either direction. When
   *    several hooks change in the same commit (e.g. FetchList's Retry
   *    handler bumps `attempt`, and the effect it triggers sets `status` in
   *    a commit that — depending on batching — can land together with it),
   *    a DOM change in that commit cannot be attributed to any one of the
   *    hooks that changed, so the transition is excluded from evidence
   *    entirely rather than counted as disqualifying for all of them. This
   *    is a genuine limitation: it makes the pruner more conservative
   *    (fewer transitions produce usable evidence), not less correct.
   *
   * A hook-value change with no DOM change is supporting evidence; a
   * hook-value change (in isolation) accompanied by a DOM change is
   * disqualifying — the hook did affect that render, so it must not be
   * pruned even if it also varied silently elsewhere.
   */
  private recomputePruning(): void {
    if (!this.domEnabled) {
      this.lastPruneReport = [];
      return;
    }

    const variedNoDom = new Map<string, number>();
    const coVaried = new Set<string>();
    const allHookNames = new Set<string>();

    for (let i = 1; i < this.history.length; i++) {
      const prev = this.history[i - 1]!;
      const cur = this.history[i]!;
      if (prev.sessionId !== cur.sessionId) continue;
      if (prev.domFingerprint === undefined || cur.domFingerprint === undefined) continue;
      const domChanged = prev.domFingerprint !== cur.domFingerprint;

      const names = new Set([...Object.keys(prev.fields), ...Object.keys(cur.fields)]);
      const changedNames = [...names].filter(
        (name) => !this.ignore.has(name) && domainOrCanon(prev.fields[name]) !== domainOrCanon(cur.fields[name]),
      );
      for (const name of names) if (!this.ignore.has(name)) allHookNames.add(name);
      if (changedNames.length !== 1) continue; // ambiguous: can't attribute a DOM change (or its absence) to one hook

      const name = changedNames[0]!;
      if (domChanged) {
        coVaried.add(name);
      } else {
        variedNoDom.set(name, (variedNoDom.get(name) ?? 0) + 1);
      }
    }

    const report: DomPruneReport[] = [];
    const nextPruned = new Set<string>();
    for (const name of allHookNames) {
      const count = variedNoDom.get(name) ?? 0;
      const everCoVaried = coVaried.has(name);
      const pruned = !everCoVaried && count >= this.domMinObservations;
      if (pruned) nextPruned.add(name);
      report.push({ hookName: name, variedNoDomCount: count, everCoVaried, pruned });
    }
    this.prunedHooks = nextPruned;
    this.lastPruneReport = report;
  }

  private computeKey(entry: HistoryEntry): string {
    if (entry.customKey !== undefined) return entry.customKey;

    const tokens: Record<string, CanonToken> = {};
    for (const [name, value] of Object.entries(entry.fields)) {
      if (this.ignore.has(name) || this.prunedHooks.has(name)) continue;
      const useLiteral = isPrimitive(value) && !this.demotedHooks.has(name);
      tokens[name] = useLiteral ? literalToken(value) : canonicalise(value);
    }
    const sortedKeys = Object.keys(tokens).sort();
    return sortedKeys.map((k) => `${k}=${stableStringify(tokens[k])}`).join("|");
  }

  /**
   * Recomputes the key for every history entry under the current rules,
   * assigns ids in first-occurrence order (reusing an existing id where a
   * new key's occupants already agree on one, so ids don't churn on every
   * call), and reports merges: cases where entries that previously had
   * *different* ids now compute to the same key. This is the retroactive
   * correction the demotion/pruning mechanism depends on for correctness —
   * see the class doc comment.
   */
  private recomputeIdsAndRekey(): void {
    const groups = new Map<string, { entries: HistoryEntry[]; priorIds: Set<StateId> }>();
    const keyOrder: string[] = [];

    for (const entry of this.history) {
      const key = this.computeKey(entry);
      if (!groups.has(key)) {
        groups.set(key, { entries: [], priorIds: new Set() });
        keyOrder.push(key);
      }
      const group = groups.get(key)!;
      group.entries.push(entry);
      if (entry.stateId) group.priorIds.add(entry.stateId);
    }

    const merges: RekeyMerge[] = [];
    for (const key of keyOrder) {
      const group = groups.get(key)!;
      let targetId: StateId;
      if (group.priorIds.size === 0) {
        targetId = this.freshId();
      } else if (group.priorIds.size === 1) {
        targetId = [...group.priorIds][0] as StateId;
      } else {
        // Multiple previously-distinct ids now collapse into one key: keep
        // the lowest-numbered (earliest-issued) id as the survivor, report
        // the rest as merged into it.
        const sorted = [...group.priorIds].sort(
          (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
        );
        targetId = sorted[0] as StateId;
        merges.push({ from: sorted.slice(1), to: targetId });
      }
      for (const entry of group.entries) entry.stateId = targetId;
    }

    if (merges.length > 0) {
      for (const cb of this.rekeyCallbacks) cb(merges);
    }
  }
}

function domainOrCanon(value: unknown): string {
  if (isPrimitive(value)) return domainKey(value);
  return stableStringify(canonicalise(value));
}
