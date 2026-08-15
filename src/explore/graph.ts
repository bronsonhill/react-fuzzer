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
  witness: { props: unknown; actions: ActionRef[] };
  domFingerprint?: string;
}

export interface Edge {
  from: string;
  to: string;
  action: ActionRef;
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

export interface ExplorationResult {
  component: string;
  graph: { states: StateNode[]; edges: Edge[] };
  unavailableActions: Array<{ state: string; action: ActionRef; reason: string }>;
  findings: { unstable: Edge[]; nonDeterministic: Edge[]; replayDivergences: ReplayDivergence[] };
  budget: { actionsUsed: number; statesFound: number; elapsedMs: number; exhausted: boolean };
  unexploredFrontier: Array<{ state: string; action: ActionRef }>;
  rekeyMerges: Array<{ from: string[]; to: string }>;
}
