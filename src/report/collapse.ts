/**
 * M6 Part 1: presentation-layer collapse of transient async chains.
 *
 * This module is a pure transform over an already-recorded graph. It does
 * not change anything the exploration engine records (see src/explore/
 * engine.ts) and the full graph, transient commits included, still goes
 * into the JSON artefact unchanged (src/report/json.ts). It only changes
 * what src/report/html.ts draws as the mermaid diagram.
 *
 * Why this exists: docs/m5-report-notes.md's honest verdict on
 * DebouncedSearch was "not reviewable as presented" -- two-thirds of its 18
 * states are transient intermediate commits (`waiting`/`searching`) that no
 * hand-authored model would ever include, and M5 did not build a way to
 * collapse them. See that report's "What would fix it, concretely" section,
 * which specifies exactly the transform implemented here.
 *
 * Transform rule: a maximal chain
 *   A --user:act--> T1 --auto--> T2 --auto--> ... --auto--> B
 * where every T_i is transient and B is settled (non-transient) becomes one
 * edge `A --act (via T1, T2, ...)--> B` in the diagram. T_i must have
 * exactly one outgoing edge for the chain to continue past it -- if a
 * transient state has more than one outgoing edge (a branch), the chain
 * cannot be collapsed past that point; that portion is left expanded and
 * reported in `branchNotes`.
 *
 * The collapsed states are NOT deleted: `collapsedStateIds` names them so
 * the caller can still list them in the state table, marked collapsed, per
 * the M6 spec ("collapsed intermediates must still be listed in the state
 * table").
 */
import type { ActionRef, Edge, ExplorationResult, Provenance, StateNode } from "../explore/graph.js";

export interface CollapsedEdge {
  kind: "collapsed";
  from: string;
  to: string;
  /** The user action that started the chain. */
  action: ActionRef;
  /** The transient state ids collapsed into this edge, in chain order. */
  via: string[];
  provenance: Provenance;
  stable: boolean;
}

export function isCollapsedEdge(e: Edge | CollapsedEdge): e is CollapsedEdge {
  return e.kind === "collapsed";
}

export interface CollapsedGraph {
  /** States to draw as diagram nodes: every state except those in collapsedStateIds. */
  states: StateNode[];
  /** Edges to draw: ordinary edges not consumed by a collapse, plus one CollapsedEdge per successfully collapsed chain. */
  edges: Array<Edge | CollapsedEdge>;
  /** Ids of transient states folded into a collapsed edge -- still present in the full graph/state table, just not drawn as diagram nodes. */
  collapsedStateIds: Set<string>;
  /** Human-readable notes about chains that could not be fully collapsed because a transient state in the chain had more than one outgoing edge. */
  branchNotes: string[];
}

function actionLabel(a: ActionRef): string {
  return a.label ?? a.id;
}

/**
 * Collapses maximal transient chains in `graph` for diagram purposes only.
 * Deterministic: iterates states/edges in a stable sort order so repeated
 * calls on the same graph produce the same collapse decisions and the same
 * `via` ordering.
 */
export function collapseTransientChains(graph: { states: StateNode[]; edges: Edge[] }): CollapsedGraph {
  const stateById = new Map(graph.states.map((s) => [s.id, s]));
  const outEdgesFrom = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    const arr = outEdgesFrom.get(e.from) ?? [];
    arr.push(e);
    outEdgesFrom.set(e.from, arr);
  }
  // Stable order: sort edges the same way html.ts's buildMermaidSource does,
  // so which "user" edge is processed first (and thus which chain is
  // discovered) is deterministic across runs of this function.
  function edgeSortKey(e: Edge): string {
    return `${e.from}::${e.kind === "user" ? e.action?.id : e.driver}::${e.to}`;
  }
  const sortedEdges = [...graph.edges].sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));

  const isTransient = (id: string) => stateById.get(id)?.transient === true;

  const consumedEdges = new Set<Edge>();
  const collapsedStateIds = new Set<string>();
  const collapsedEdges: CollapsedEdge[] = [];
  const branchNotes: string[] = [];

  for (const startEdge of sortedEdges) {
    if (startEdge.kind !== "user") continue;
    if (!isTransient(startEdge.to)) continue; // nothing to collapse; target already settled

    const chain: string[] = [];
    const chainEdges: Edge[] = [];
    let cur = startEdge.to;
    let branched = false;
    let branchAt: string | undefined;

    while (isTransient(cur)) {
      const outs = (outEdgesFrom.get(cur) ?? []).filter((e) => e.kind === "auto");
      // Duplicate edges to the same destination (e.g. two independent
      // witnesses landing on the same auto transition) are not a branch --
      // only a genuine second *distinct* destination is. Non-auto outgoing
      // edges (shouldn't normally exist from a transient node, since the
      // engine doesn't seed user actions there -- see StateNode.transient's
      // doc comment) also count as a branch if present.
      const allOuts = outEdgesFrom.get(cur) ?? [];
      const distinctTargets = new Set(outs.map((e) => e.to));
      if (allOuts.length !== outs.length || distinctTargets.size !== 1) {
        branched = true;
        branchAt = cur;
        break;
      }
      chain.push(cur);
      chainEdges.push(...outs);
      cur = [...distinctTargets][0]!;
    }

    if (branched) {
      branchNotes.push(
        `Chain starting ${startEdge.from} --${actionLabel(startEdge.action!)}--> ${startEdge.to} was left expanded: ` +
          `transient state ${branchAt} has more than one outgoing edge, so the chain cannot be collapsed past that branch point.`,
      );
      continue;
    }

    // cur is now settled (non-transient); chain collapses into one edge.
    consumedEdges.add(startEdge);
    for (const e of chainEdges) consumedEdges.add(e);
    for (const id of chain) collapsedStateIds.add(id);

    collapsedEdges.push({
      kind: "collapsed",
      from: startEdge.from,
      to: cur,
      action: startEdge.action!,
      via: chain,
      provenance: chainEdges.length > 0 ? chainEdges[chainEdges.length - 1]!.provenance : startEdge.provenance,
      stable: startEdge.stable && chainEdges.every((e) => e.stable),
    });
  }

  const remainingEdges = graph.edges.filter((e) => !consumedEdges.has(e));
  const states = graph.states.filter((s) => !collapsedStateIds.has(s.id));

  return {
    states,
    edges: [...remainingEdges, ...collapsedEdges],
    collapsedStateIds,
    branchNotes,
  };
}

/** Convenience: collapse an ExplorationResult's graph, leaving the ExplorationResult itself untouched (JSON artefact fidelity). */
export function collapseExplorationGraph(result: ExplorationResult): CollapsedGraph {
  return collapseTransientChains(result.graph);
}
