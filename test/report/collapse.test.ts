/**
 * M6 Part 1 unit tests for src/report/collapse.ts, using hand-built graphs
 * (not a real exploration run) since the transform is a pure function over
 * an already-recorded graph and the interesting cases -- a clean chain, a
 * branch mid-chain, duplicate edges to the same destination -- are easiest
 * to construct directly. The transform's effect on a real component's
 * graph is covered by test/report/html-collapse.test.tsx (DebouncedSearch).
 */
import { describe, expect, it } from "vitest";
import { collapseTransientChains } from "../../src/report/collapse.js";
import type { Edge, StateNode } from "../../src/explore/graph.js";

function state(id: string, transient: boolean): StateNode {
  return { id, key: id, fields: {}, provenance: "default-props", witness: { props: {}, actions: [] }, transient };
}
function userEdge(from: string, to: string, actionId = "act"): Edge {
  return { from, to, kind: "user", action: { id: actionId, kind: "click", label: actionId }, provenance: "default-props", stable: true };
}
function autoEdge(from: string, to: string): Edge {
  return { from, to, kind: "auto", driver: "timer", provenance: "default-props", stable: true };
}

describe("report/collapse", () => {
  it("collapses a clean A -> T1 -> T2 -> B chain into one labelled edge", () => {
    const states = [state("A", false), state("T1", true), state("T2", true), state("B", false)];
    const edges = [userEdge("A", "T1"), autoEdge("T1", "T2"), autoEdge("T2", "B")];
    const collapsed = collapseTransientChains({ states, edges });

    expect(collapsed.states.map((s) => s.id).sort()).toEqual(["A", "B"]);
    expect(collapsed.collapsedStateIds).toEqual(new Set(["T1", "T2"]));
    expect(collapsed.edges).toHaveLength(1);
    const edge = collapsed.edges[0]!;
    expect(edge.kind).toBe("collapsed");
    if (edge.kind === "collapsed") {
      expect(edge.from).toBe("A");
      expect(edge.to).toBe("B");
      expect(edge.via).toEqual(["T1", "T2"]);
    }
    expect(collapsed.branchNotes).toEqual([]);
  });

  it("leaves a chain expanded when a transient state has more than one distinct outgoing destination (a real branch)", () => {
    const states = [state("A", false), state("T1", true), state("B1", false), state("B2", false)];
    const edges = [userEdge("A", "T1"), autoEdge("T1", "B1"), autoEdge("T1", "B2")];
    const collapsed = collapseTransientChains({ states, edges });

    // Nothing collapsed: all four states still drawn, all three edges kept as-is.
    expect(collapsed.states.map((s) => s.id).sort()).toEqual(["A", "B1", "B2", "T1"]);
    expect(collapsed.collapsedStateIds.size).toBe(0);
    expect(collapsed.edges).toHaveLength(3);
    expect(collapsed.branchNotes).toHaveLength(1);
    expect(collapsed.branchNotes[0]).toMatch(/branch/i);
  });

  it("treats duplicate edges to the SAME destination as one continuation, not a branch", () => {
    const states = [state("A", false), state("T1", true), state("B", false)];
    const edges = [userEdge("A", "T1"), autoEdge("T1", "B"), autoEdge("T1", "B")]; // duplicate auto edge, same target
    const collapsed = collapseTransientChains({ states, edges });

    expect(collapsed.collapsedStateIds).toEqual(new Set(["T1"]));
    expect(collapsed.branchNotes).toEqual([]);
    const collapsedEdge = collapsed.edges.find((e) => e.kind === "collapsed");
    expect(collapsedEdge).toBeDefined();
  });

  it("does not touch a user edge landing directly on a settled state (nothing to collapse)", () => {
    const states = [state("A", false), state("B", false)];
    const edges = [userEdge("A", "B")];
    const collapsed = collapseTransientChains({ states, edges });

    expect(collapsed.states).toHaveLength(2);
    expect(collapsed.edges).toEqual(edges);
    expect(collapsed.collapsedStateIds.size).toBe(0);
  });

  it("is deterministic across repeated calls on the same graph", () => {
    const states = [state("A", false), state("T1", true), state("T2", true), state("B", false)];
    const edges = [userEdge("A", "T1"), autoEdge("T1", "T2"), autoEdge("T2", "B")];
    const first = collapseTransientChains({ states, edges });
    const second = collapseTransientChains({ states, edges });
    expect(JSON.stringify([...first.collapsedStateIds].sort())).toBe(JSON.stringify([...second.collapsedStateIds].sort()));
    expect(first.edges).toEqual(second.edges);
  });
});
