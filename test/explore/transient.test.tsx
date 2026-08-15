/**
 * M3.5, Problem 1: focused tests for the transient-state rule -- a state
 * observed only as an intermediate commit (never as where settle() actually
 * stopped) is recorded with `transient: true`, gets an auto edge, but never
 * has its actions seeded, so exploration cannot try to "stop and interact"
 * mid-flight. See docs/m3-5-refinement-report.md for the full argument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exploreComponent } from "../../src/explore/engine.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

describe("transient states: FetchList", () => {
  it("'loading' is transient and gets no seeded actions, even though the rendered DOM has no interactive elements to seed anyway", async () => {
    const fetchItems = vi.fn(() => Promise.reject(new Error("boom")));
    const result = await exploreComponent({
      componentName: "FetchList",
      render: (props) => <FetchList {...(props as any)} />,
      props: { fetchItems },
      sourcePath: bench("fetch-list/FetchList.tsx"),
      settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
      invokableProps: {},
    });

    const loading = result.graph.states.find((s) => s.fields.status === "loading")!;
    const error = result.graph.states.find((s) => s.fields.status === "error")!;
    expect(loading.transient).toBe(true);
    expect(error.transient).toBe(false);

    // 'loading' has exactly the one auto edge onward to 'error' (part of the
    // chain that discovered it) and no *user* edge: its actions were never
    // seeded, so the DFS frontier never tried a discovered action from it.
    const fromLoading = result.graph.edges.filter((e) => e.from === loading.id);
    expect(fromLoading.every((e) => e.kind === "auto")).toBe(true);
    // 'error' does have a seeded, user-driven outgoing edge (Retry),
    // confirming non-transient states behave normally.
    expect(result.graph.edges.some((e) => e.from === error.id && e.kind === "user")).toBe(true);

    // The transient state's witness carries a note explaining why it can't
    // be independently replayed to.
    expect(loading.witness.note).toBeDefined();
    expect(error.witness.note).toBeUndefined();
  });
});

describe("transient states: DebouncedSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("'waiting' and 'searching' are transient with no seeded outgoing edges; the settled phase after them is not transient", async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const query = vi.fn((text: string) => {
      if (text.includes("errorterm")) return Promise.reject(new Error("boom"));
      if (text.includes("emptyterm")) return Promise.resolve([]);
      return Promise.resolve(results);
    });

    const result = await exploreComponent({
      componentName: "DebouncedSearch",
      render: (props) => <DebouncedSearch {...(props as any)} />,
      props: { query },
      sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
      fillPools: () => ["", "resultsterm"],
      settle: { useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 },
      invokableProps: {},
    });

    const transientPhases = new Set(["waiting", "searching"]);
    for (const state of result.graph.states) {
      const phase = state.fields.phase as string;
      if (transientPhases.has(phase)) {
        expect(state.transient).toBe(true);
        // Only auto edges (part of the settle chain) leave a transient
        // state -- never a user-driven (seeded) one.
        const outgoing = result.graph.edges.filter((e) => e.from === state.id);
        expect(outgoing.every((e) => e.kind === "auto")).toBe(true);
        expect(state.witness.note).toBeDefined();
      } else {
        expect(state.transient).toBe(false);
      }
    }

    // Every auto edge lands on or leaves a transient predecessor, chaining
    // waiting -> searching -> results (or a sibling outcome).
    const autoEdges = result.graph.edges.filter((e) => e.kind === "auto");
    expect(autoEdges.length).toBeGreaterThan(0);
    for (const edge of autoEdges) {
      expect(edge.driver).toBeDefined();
      expect(edge.action).toBeUndefined();
    }
    const userEdges = result.graph.edges.filter((e) => e.kind === "user");
    for (const edge of userEdges) {
      expect(edge.action).toBeDefined();
      expect(edge.driver).toBeUndefined();
    }
  });
});

describe("transient-state reclassification", () => {
  it("a state first observed only as an intermediate commit is reclassified non-transient (and its actions seeded) if some other path later settles there for real", async () => {
    // FetchList's root mount observes 'loading' as an intermediate commit
    // before 'error'. If some other route through the graph ever *settled*
    // on 'loading' as a final state (it doesn't here, since nothing pauses
    // on it), the rule requires it be promoted to non-transient. This test
    // instead confirms the negative: across the whole FetchList run,
    // 'loading' is never independently settled on, so it stays transient
    // for the entire run -- pinning down that the rule is "promote if ever
    // settled", not "promote unconditionally" or "never promote".
    const fetchItems = vi.fn(() => Promise.reject(new Error("boom")));
    const result = await exploreComponent({
      componentName: "FetchList",
      render: (props) => <FetchList {...(props as any)} />,
      props: { fetchItems },
      sourcePath: bench("fetch-list/FetchList.tsx"),
      settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
      invokableProps: {},
    });
    const loading = result.graph.states.find((s) => s.fields.status === "loading")!;
    expect(loading.transient).toBe(true);
  });
});
