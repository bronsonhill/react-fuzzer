/**
 * M5 Deliverable A: JSON artefact. Serialises an ExplorationResult (single-
 * assignment, from src/explore/engine.ts) or a MultiAssignmentResult
 * (multi-assignment, from src/props/explore.ts) into a stable, versioned
 * JSON document.
 *
 * This is the durable artefact M6 would diff a later run against, so two
 * properties matter more than for an ordinary debug dump:
 *
 *  - Determinism: every collection (states, edges, findings, ...) is sorted
 *    by a content key before serialisation, so two runs that explore the
 *    same component to the same graph produce byte-identical output even
 *    though the engine's internal Map/Set iteration order and DFS visitation
 *    order are not guaranteed to match run to run.
 *  - No wall-clock noise: `elapsedMs` fields are rounded to the nearest
 *    whole millisecond. They are kept (rather than omitted) because budget
 *    usage is part of what a developer reviews, but rounding keeps ordinary
 *    jitter from being the sole cause of two equivalent runs differing.
 */
import type { ExplorationResult, StateNode, Edge, ActionRef, DomPruneReportEntry } from "../explore/graph.js";
import type { MultiAssignmentResult, DistinctShapeGroup, ResponsibleProp, AssignmentBudget, PropAssignment } from "../props/explore.js";

export const REPORT_SCHEMA_VERSION = 1;

function sortActionRef(a: ActionRef): ActionRef {
  // ActionRef fields are already flat/primitive; no nested sorting needed.
  return a;
}

function sortStates(states: StateNode[]): StateNode[] {
  return [...states]
    .map((s) => ({ ...s, witness: { ...s.witness, actions: s.witness.actions.map(sortActionRef) } }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function edgeSortKey(e: Edge): string {
  const actionPart = e.kind === "user" ? (e.action?.id ?? "") : (e.driver ?? "");
  return `${e.from}::${actionPart}::${e.to}`;
}

function sortEdges(edges: Edge[]): Edge[] {
  return [...edges].sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
}

function serializeResult(result: ExplorationResult): Record<string, unknown> {
  return {
    component: result.component,
    graph: {
      states: sortStates(result.graph.states),
      edges: sortEdges(result.graph.edges),
    },
    unavailableActions: [...result.unavailableActions].sort((a, b) =>
      `${a.state}::${a.action.id}`.localeCompare(`${b.state}::${b.action.id}`),
    ),
    findings: {
      unstable: sortEdges(result.findings.unstable),
      nonDeterministic: sortEdges(result.findings.nonDeterministic),
      replayDivergences: [...result.findings.replayDivergences].sort((a, b) => a.state.localeCompare(b.state)),
    },
    // elapsedMs is intentionally omitted from the versioned document: it is
    // wall-clock noise (see this module's doc comment) and two explorations
    // of the same component with the same fixed props can differ in it by
    // tens of milliseconds even when the resulting graph is identical,
    // which would make the JSON artefact non-deterministic for reasons that
    // have nothing to do with the graph. Callers that want timing (e.g. the
    // HTML report's budget section) read it off the in-memory
    // ExplorationResult directly, not off this artefact.
    budget: {
      actionsUsed: result.budget.actionsUsed,
      statesFound: result.budget.statesFound,
      exhausted: result.budget.exhausted,
    },
    unexploredFrontier: [...result.unexploredFrontier]
      .sort((a, b) => `${a.state}::${a.action.id}`.localeCompare(`${b.state}::${b.action.id}`)),
    rekeyMerges: [...result.rekeyMerges].sort((a, b) => a.to.localeCompare(b.to)),
    domPruneReport: [...result.domPruneReport].sort((a, b) => a.hookName.localeCompare(b.hookName)) as DomPruneReportEntry[],
    demotedHooks: [...result.demotedHooks].sort(),
    prunedHooks: [...result.prunedHooks].sort(),
  };
}

function assignmentSortKey(a: PropAssignment): string {
  return `${a.source}::${a.variedProp ?? ""}::${JSON.stringify(a.props, Object.keys(a.props).sort())}`;
}

function serializeMulti(result: MultiAssignmentResult): Record<string, unknown> {
  return {
    merged: serializeResult(result.merged),
    runs: [...result.runs]
      .sort((a, b) => assignmentSortKey(a.assignment).localeCompare(assignmentSortKey(b.assignment)))
      .map((r) => ({
        assignment: r.assignment,
        shapeHash: r.shapeHash,
        result: serializeResult(r.result),
      })),
    distinctShapes: [...result.distinctShapes]
      .sort((a, b) => a.shapeHash.localeCompare(b.shapeHash))
      .map((g: DistinctShapeGroup) => ({
        ...g,
        assignments: [...g.assignments].sort((a, b) => assignmentSortKey(a).localeCompare(assignmentSortKey(b))),
      })),
    responsibleProps: [...result.responsibleProps].sort((a, b) => a.prop.localeCompare(b.prop)) as ResponsibleProp[],
    // See serializeResult's comment on elapsedMs: omitted from the merged
    // and per-run budgets for the same reason (wall-clock noise, not part
    // of the graph the JSON artefact needs to be stable for).
    budget: {
      perAssignment: [...result.budget.perAssignment]
        .sort((a, b) => assignmentSortKey(a.assignment).localeCompare(assignmentSortKey(b.assignment)))
        .map((b: AssignmentBudget) => ({ assignment: b.assignment, actionsUsed: b.actionsUsed, statesFound: b.statesFound, exhausted: b.exhausted })),
      aggregate: { actionsUsed: result.budget.aggregate.actionsUsed, statesFound: result.budget.aggregate.statesFound, anyExhausted: result.budget.aggregate.anyExhausted },
    },
  };
}

/** Serialises a single-assignment ExplorationResult to a stable JSON string. */
export function explorationResultToJson(result: ExplorationResult, pretty = true): string {
  const doc = { schemaVersion: REPORT_SCHEMA_VERSION, kind: "single-assignment", ...serializeResult(result) };
  return JSON.stringify(doc, null, pretty ? 2 : undefined);
}

/** Serialises a merged MultiAssignmentResult to a stable JSON string. */
export function multiAssignmentResultToJson(result: MultiAssignmentResult, pretty = true): string {
  const doc = { schemaVersion: REPORT_SCHEMA_VERSION, kind: "multi-assignment", ...serializeMulti(result) };
  return JSON.stringify(doc, null, pretty ? 2 : undefined);
}
