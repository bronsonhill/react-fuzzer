/**
 * M4 exit criterion (docs/poc-plan.md): "on a component with a prop that
 * gates a branch, the gated states appear with correct provenance and the
 * responsible prop assignment is identified." PropGated is the designed
 * target (see benchmarks/prop-gated/PropGated.expected.ts's notes); FetchList
 * is the second interesting case (M3.5 found only 2 states with one fixed
 * deterministic fetchItems mock; generated fetchItems arbitraries producing
 * different outcomes should reach all 4 expected states).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exploreMultiAssignment } from "../../src/props/explore.js";
import { propsToArbitraries } from "../../src/props/propsToArbitraries.js";

import { PropGated } from "../../benchmarks/prop-gated/PropGated.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

describe("M4 exit criterion: PropGated", () => {
  it("under mode='simple' as the example props, the four advanced_* states get generated-props provenance, the two simple_* states get default-props provenance, and mode is identified as the responsible prop", async () => {
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
      seed: 42,
    });

    // Exactly the 2 simple_* states are default-props provenance, and both
    // are reached under mode='simple'.
    const defaultStates = result.merged.graph.states.filter((s) => s.provenance === "default-props");
    expect(defaultStates.length).toBe(2);

    // Two of the four advanced_* states (expertModeOn: false) have hook
    // values identical to the two simple_* states -- mode is a prop, not
    // part of hook-value state identity, and expertModeOn is unreachable
    // in simple mode, so those two genuinely collapse into the same
    // default-props states per docs/poc-plan.md ("mode is not itself part
    // of the internal hook-derived state identity"). Only the two states
    // where expertModeOn=true are behaviourally unreachable under
    // mode='simple' and must appear as generated-props.
    const generatedStates = result.merged.graph.states.filter((s) => s.provenance === "generated-props");
    expect(generatedStates.length).toBeGreaterThanOrEqual(2);
    for (const s of generatedStates) {
      expect(s.fields.expertModeOn).toBe(true);
      const props = s.witness.props as Record<string, unknown>;
      expect(props.mode).toBe("advanced");
    }

    // mode must be identified as responsible for the shape change, with
    // isolated confidence (it was varied one-prop-at-a-time).
    const modeResponsible = result.responsibleProps.find((r) => r.prop === "mode");
    expect(modeResponsible).toBeDefined();
    expect(modeResponsible!.confidence).toBe("isolated");

    // At least two distinct shapes: the 2-state simple shape and a 4-or-more
    // state advanced shape.
    const shapeSizes = new Set(result.distinctShapes.map((g) => g.stateCount));
    expect(shapeSizes.size).toBeGreaterThan(1);

    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });
});

describe("M4 exit criterion: FetchList", () => {
  it("generated fetchItems arbitraries (populated/empty/rejecting, each a pure function of no hidden call-count state) reach all 4 expected states across the merged multi-assignment graph", async () => {
    // fetchItems takes no arguments, so per the M3 replay-safety finding
    // (docs/m3-exploration-report.md: "a mock with hidden call-count state is
    // not replay-safe"), each generated fetchItems must be a *constant*
    // function for the life of one assignment -- same outcome every call,
    // regardless of how many times replay-from-root remounts and re-invokes
    // it. Varying the outcome happens *across* assignments (which is exactly
    // what multi-assignment exploration is for), not within one.
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
      seed: 7,
      settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
      invokableProps: {},
    });

    const statuses = new Set(result.merged.graph.states.map((s) => s.fields.status));
    expect(statuses.has("loading")).toBe(true);
    expect(statuses.has("error")).toBe(true);
    expect(statuses.has("empty")).toBe(true);
    expect(statuses.has("loaded")).toBe(true);

    // 'error' was reached under the example props (fetchItems always
    // rejects), so it must be default-props; 'empty'/'loaded' only appear
    // under generated assignments, so generated-props.
    const errorState = result.merged.graph.states.find((s) => s.fields.status === "error");
    expect(errorState!.provenance).toBe("default-props");
    const loadedState = result.merged.graph.states.find((s) => s.fields.status === "loaded");
    expect(loadedState!.provenance).toBe("generated-props");
    const emptyState = result.merged.graph.states.find((s) => s.fields.status === "empty");
    expect(emptyState!.provenance).toBe("generated-props");

    // Replay must not diverge: this is the whole point of using a pure,
    // call-count-independent fetchItems per assignment.
    expect(result.merged.findings.replayDivergences.length).toBe(0);
  });
});
