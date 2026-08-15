/**
 * M4 corpus run: multi-assignment exploration across every benchmark
 * component, for docs/m4-props-report.md. Not asserting tight numbers
 * everywhere (this is a measurement pass, like docs/m3-exploration-report.md's
 * one-off timing run) but does assert the run completes without replay
 * divergences where the component's function props are pure, and prints a
 * summary table consumed by hand when writing the report.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

import { exploreMultiAssignment } from "../../src/props/explore.js";
import { propsToArbitraries } from "../../src/props/propsToArbitraries.js";

import { Toggle } from "../../benchmarks/toggle/Toggle.js";
import { Counter } from "../../benchmarks/counter/Counter.js";
import { PropGated } from "../../benchmarks/prop-gated/PropGated.js";
import { Wizard } from "../../benchmarks/wizard/Wizard.js";
import { ValidatedForm } from "../../benchmarks/validated-form/ValidatedForm.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

function summarize(label: string, result: Awaited<ReturnType<typeof exploreMultiAssignment>>): void {
  const provCounts = { "default-props": 0, "generated-props": 0, injected: 0 };
  for (const s of result.merged.graph.states) provCounts[s.provenance]++;
  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${label} ===\n` +
      `runs: ${result.runs.length}, merged states: ${result.merged.graph.states.length}, ` +
      `merged edges: ${result.merged.graph.edges.length}\n` +
      `provenance: default-props=${provCounts["default-props"]} generated-props=${provCounts["generated-props"]}\n` +
      `distinct shapes: ${result.distinctShapes.length} (sizes: ${result.distinctShapes.map((g) => g.stateCount).join(",")})\n` +
      `responsible props: ${result.responsibleProps.map((r) => `${r.prop}(${r.confidence})`).join(", ") || "none"}\n` +
      `budget aggregate: actionsUsed=${result.budget.aggregate.actionsUsed} elapsedMs=${result.budget.aggregate.elapsedMs.toFixed(1)} anyExhausted=${result.budget.aggregate.anyExhausted}\n` +
      `replay divergences: ${result.merged.findings.replayDivergences.length}`,
  );
}

describe("M4 corpus: multi-assignment exploration", () => {
  it("Toggle", async () => {
    const { arbitraries } = propsToArbitraries({ sourcePath: bench("toggle/Toggle.tsx"), componentName: "Toggle" });
    const result = await exploreMultiAssignment({
      componentName: "Toggle",
      render: (props) => <Toggle {...(props as any)} />,
      sourcePath: bench("toggle/Toggle.tsx"),
      exampleProps: { label: "Power" },
      arbitraries,
      sampleCount: 5,
      varyPerProp: 2,
      seed: 1,
    });
    summarize("Toggle", result);
    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });

  it("Counter", async () => {
    const { arbitraries } = propsToArbitraries({ sourcePath: bench("counter/Counter.tsx"), componentName: "Counter" });
    const result = await exploreMultiAssignment({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      sourcePath: bench("counter/Counter.tsx"),
      exampleProps: { min: 0, max: 5, start: 0 },
      arbitraries,
      sampleCount: 5,
      varyPerProp: 2,
      seed: 2,
    });
    summarize("Counter", result);
    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });

  it("PropGated", async () => {
    const { arbitraries } = propsToArbitraries({
      sourcePath: bench("prop-gated/PropGated.tsx"),
      componentName: "PropGated",
    });
    const result = await exploreMultiAssignment({
      componentName: "PropGated",
      render: (props) => <PropGated {...(props as any)} />,
      sourcePath: bench("prop-gated/PropGated.tsx"),
      exampleProps: { mode: "simple" },
      arbitraries,
      sampleCount: 6,
      varyPerProp: 3,
      seed: 3,
    });
    summarize("PropGated", result);
    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });

  it("Wizard", async () => {
    const { arbitraries } = propsToArbitraries({
      sourcePath: bench("wizard/Wizard.tsx"),
      componentName: "Wizard",
      propOverrides: { onComplete: fc.constant(() => {}) },
    });
    const result = await exploreMultiAssignment({
      componentName: "Wizard",
      render: (props) => <Wizard {...(props as any)} />,
      sourcePath: bench("wizard/Wizard.tsx"),
      exampleProps: { onComplete: undefined },
      arbitraries,
      sampleCount: 3,
      varyPerProp: 2,
      seed: 4,
      fillPools: (field) => {
        if (/name/i.test(field.name)) return ["", "Ada"];
        if (/email/i.test(field.name)) return ["", "ada@example.com"];
        return undefined;
      },
    });
    summarize("Wizard", result);
    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });

  it("ValidatedForm", async () => {
    const { arbitraries } = propsToArbitraries({
      sourcePath: bench("validated-form/ValidatedForm.tsx"),
      componentName: "ValidatedForm",
      propOverrides: { onSubmit: fc.constant(() => {}) },
    });
    const fillPools = (field: { name: string }) => {
      if (/email/i.test(field.name)) return ["", "not-an-email@", "ada@example.com"];
      if (/password/i.test(field.name)) return ["", "short", "longenough1"];
      return undefined;
    };
    const result = await exploreMultiAssignment({
      componentName: "ValidatedForm",
      render: (props) => <ValidatedForm {...(props as any)} />,
      sourcePath: bench("validated-form/ValidatedForm.tsx"),
      exampleProps: { onSubmit: undefined },
      arbitraries,
      sampleCount: 3,
      varyPerProp: 2,
      seed: 5,
      fillPools,
    });
    summarize("ValidatedForm", result);
    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });

  it("FetchList", async () => {
    type Outcome = "populated" | "empty" | "reject";
    const items: Item[] = [{ id: "1", label: "One" }];
    function makeFetchItems(outcome: Outcome): () => Promise<Item[]> {
      if (outcome === "reject") return () => Promise.reject(new Error("boom"));
      if (outcome === "empty") return () => Promise.resolve([]);
      return () => Promise.resolve(items);
    }
    const fetchItemsArb = fc
      .constantFrom<Outcome>("populated", "empty", "reject")
      .map((outcome) => makeFetchItems(outcome));

    const result = await exploreMultiAssignment({
      componentName: "FetchList",
      render: (props) => <FetchList {...(props as any)} />,
      sourcePath: bench("fetch-list/FetchList.tsx"),
      exampleProps: { fetchItems: makeFetchItems("reject") },
      arbitraries: { fetchItems: fetchItemsArb },
      sampleCount: 6,
      varyPerProp: 3,
      seed: 6,
      settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
      invokableProps: {},
    });
    summarize("FetchList", result);
    expect(result.merged.findings.replayDivergences.length).toBe(0);

    const statuses = new Set(result.merged.graph.states.map((s) => s.fields.status));
    expect(statuses.has("loading")).toBe(true);
    expect(statuses.has("error")).toBe(true);
    expect(statuses.has("empty")).toBe(true);
    expect(statuses.has("loaded")).toBe(true);
  });

  describe("DebouncedSearch", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("query is a fixed pure function of its text argument (an override, not sampled -- see report)", async () => {
      const results: SearchResult[] = [{ id: "1", label: "Result A" }];
      const query = (text: string): Promise<SearchResult[]> => {
        if (text.includes("errorterm")) return Promise.reject(new Error("boom"));
        if (text.includes("emptyterm")) return Promise.resolve([]);
        return Promise.resolve(results);
      };
      const { arbitraries } = propsToArbitraries({
        sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
        componentName: "DebouncedSearch",
        propOverrides: { query: fc.constant(query) },
      });

      const result = await exploreMultiAssignment({
        componentName: "DebouncedSearch",
        render: (props) => <DebouncedSearch {...(props as any)} />,
        sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
        exampleProps: { query, debounceMs: 300 },
        arbitraries,
        sampleCount: 3,
        varyPerProp: 2,
        seed: 7,
        fillPools: () => ["", "resultsterm", "emptyterm", "errorterm"],
        settle: { useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 },
        invokableProps: {},
      });
      summarize("DebouncedSearch", result);
      expect(result.merged.findings.replayDivergences.length).toBe(0);
    });
  });
});
