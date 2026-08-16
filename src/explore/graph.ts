/**
 * M3: serialisable graph model produced by the exploration engine
 * (./engine.ts). Everything M3 produces has provenance `default-props`; M4
 * will add `generated-props` and the schema-only `injected` tier is not
 * produced by anything yet (see docs/poc-plan.md's provenance table).
 */

export type Provenance = "default-props" | "generated-props" | "injected";

export type ActionKind = "click" | "fill" | "toggle" | "select" | "invokeProp";

/**
 * A candidate or recorded action. `id` is a stable identifier derived from
 * accessible role + accessible name + a disambiguating index (see
 * ./actions.ts) — never DOM position, never a fiber-internal handle — so the
 * same id is produced across two independent renders of equivalent output,
 * which is what makes replay-from-root and witness replay possible.
 */
export interface ActionRef {
  id: string;
  kind: ActionKind;
  label: string;
  /** For `fill`: the value to set via a single fireEvent.change. */
  value?: string;
  /** For `select`: the <option> value to select. */
  optionValue?: string;
  /** For `invokeProp`: the prop name on the root component being invoked. */
  propName?: string;
}

export interface StateNode {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  provenance: Provenance;
  witness: {
    props: unknown;
    actions: ActionRef[];
    /**
     * Set when this state is only reachable via an automatic transition
     * (a timer firing, a promise resolving) after `actions`, not by
     * `actions` alone landing here directly under settle()'s
     * settle-to-quiescence contract. Such a state cannot be independently
     * replayed to (replaying `actions` and settling will run straight past
     * it to wherever it actually settles) — see `transient` below.
     */
    note?: string;
  };
  domFingerprint?: string;
  /**
   * True for a state observed only as an intermediate commit en route to
   * quiescence — never (yet) observed as the point where settle() actually
   * stopped. Exploration does not try user actions from a transient state
   * (see docs/m3-5-refinement-report.md's "transient-state rule"): trying to
   * stop and interact mid-flight isn't something settle()'s contract can
   * reproduce, and treating a transient state as an ordinary frontier node
   * would explode the graph with states no replay could ever land back on.
   * A state can start transient and later be reclassified (transient:
   * false) if some other action sequence settles there for real; once that
   * happens its actions are seeded like any other state's.
   */
  transient?: boolean;
}

export type EdgeKind = "user" | "auto";

/** What (as far as the engine can honestly tell) drove an `auto` edge. See CommitDriver in src/settle.ts. */
export type AutoDriver = "timer" | "microtask";

export interface Edge {
  from: string;
  to: string;
  /** `"user"`: caused by a discovered UI action (`action` is set). `"auto"`: no user input, observed as a later commit within the same settle() call that the preceding user action started (`driver` says what, if known, drove it). */
  kind: EdgeKind;
  /** Set when kind is "user". */
  action?: ActionRef;
  /** Set when kind is "auto". */
  driver?: AutoDriver;
  provenance: Provenance;
  stable: boolean;
  nonDeterministic?: { observedDestinations: string[] };
}

export interface ReplayDivergence {
  state: string;
  expectedId: string;
  actualId: string;
  witness: ActionRef[];
}

export interface DomPruneReportEntry {
  hookName: string;
  variedNoDomCount: number;
  everCoVaried: boolean;
  pruned: boolean;
}

export interface ExplorationResult {
  component: string;
  graph: { states: StateNode[]; edges: Edge[] };
  unavailableActions: Array<{ state: string; action: ActionRef; reason: string }>;
  findings: { unstable: Edge[]; nonDeterministic: Edge[]; replayDivergences: ReplayDivergence[] };
  budget: { actionsUsed: number; statesFound: number; elapsedMs: number; exhausted: boolean };
  unexploredFrontier: Array<{ state: string; action: ActionRef }>;
  rekeyMerges: Array<{ from: string[]; to: string }>;
  /**
   * M2.5's DOM-correlation pruner report (see src/abstraction/adaptive.ts's
   * getDomPruneReport): hooks the abstraction excluded from state identity
   * because they never observably co-varied with the DOM. Reported here,
   * always, per docs/poc-plan.md's M2.5 requirement that pruning is
   * surfaced prominently rather than applied silently.
   */
  domPruneReport: DomPruneReportEntry[];
}
