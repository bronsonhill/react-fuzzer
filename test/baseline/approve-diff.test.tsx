/**
 * M6 Part 2 tests: approve/diff against a real benchmark component
 * (Counter), covering:
 *
 *  1. approve then re-run unchanged -> clean diff (the most important test:
 *     a spurious diff on an unchanged component makes the whole tool
 *     useless as a regression check).
 *  2. approve on the real benchmarks/counter/Counter.tsx, diff against a
 *     deliberately modified COPY in test/fixtures/counter-modified/ (never
 *     the original) -- asserts the diff catches exactly the added state,
 *     the removed transition (and its cascading unreachable states), and
 *     nothing spurious beyond that.
 *  3. a forced demotion/rekey scenario -- diffing a baseline built under a
 *     generous literalDomainLimit against a run under a much stricter one
 *     -- asserts the resulting merge is reported as abstraction churn, not
 *     lost states. This is the single most important correctness
 *     requirement per docs/poc-plan.md's M6 section.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exploreComponent } from "../../src/explore/engine.js";
import { buildBaseline } from "../../src/baseline/build.js";
import { diffAgainstBaseline } from "../../src/baseline/diff.js";

import { Counter } from "../../benchmarks/counter/Counter.js";
import { Counter as ModifiedCounter } from "../fixtures/counter-modified/Counter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}
function fixture(relPath: string): string {
  return path.join(repoRoot, "test/fixtures", relPath);
}

const exampleProps = { min: 0, max: 5, start: 0 };

describe("M6 baseline approve/diff", () => {
  it("re-running an unchanged component against its own baseline produces a CLEAN diff", async () => {
    const first = await exploreComponent({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      props: exampleProps,
      sourcePath: bench("counter/Counter.tsx"),
    });
    const baseline = buildBaseline(first);

    const second = await exploreComponent({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      props: exampleProps,
      sourcePath: bench("counter/Counter.tsx"),
    });
    const report = diffAgainstBaseline(baseline, second);

    expect(report.newStates).toEqual([]);
    expect(report.lostStates).toEqual([]);
    expect(report.newTransitions).toEqual([]);
    expect(report.lostTransitions).toEqual([]);
    expect(report.provenanceChanges).toEqual([]);
    expect(report.stabilityChanges).toEqual([]);
    expect(report.abstractionChurnMerges).toEqual([]);
    expect(report.hasDifferences).toBe(false);
  });

  it("catches a deliberate behaviour change (new state, removed transition) and nothing spurious", async () => {
    const baselineRun = await exploreComponent({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      props: exampleProps,
      sourcePath: bench("counter/Counter.tsx"),
    });
    const baseline = buildBaseline(baselineRun);

    const modifiedRun = await exploreComponent({
      componentName: "Counter",
      render: (props) => <ModifiedCounter {...(props as any)} />,
      props: exampleProps,
      sourcePath: fixture("counter-modified/Counter.tsx"),
    });
    const report = diffAgainstBaseline(baseline, modifiedRun);

    expect(report.hasDifferences).toBe(true);

    // Exactly one genuinely new state: the "pinged" terminal screen
    // (value=-1, a sentinel the original component's clamped range never
    // produces).
    expect(report.newStates).toHaveLength(1);
    expect(report.newStates[0]!.key).toBe('value="lit:-1"');

    // Blocking increment at value=3 has a cascading effect worth being
    // honest about: the ONLY way the original component ever reaches
    // value=4 or value=5 is by incrementing up from 0 (decrement never
    // increases value), so gating increment at 3 makes both value=4 and
    // value=5 genuinely unreachable, not just the single 3->4 transition.
    // This is a real regression and the diff is right to catch it as lost
    // states, not just a lost transition.
    const lostKeys = report.lostStates.map((s) => s.key).sort();
    expect(lostKeys).toEqual(['value="lit:4"', 'value="lit:5"'].sort());

    // The value=3 --increment--> value=4 transition is gone (its target no longer exists).
    expect(report.lostTransitions.some((t) => t.action.includes("increment"))).toBe(true);

    // New transitions: at least the "ping" action from every reachable value state into the new terminal state.
    expect(report.newTransitions.some((t) => t.action.includes("ping"))).toBe(true);

    // Nothing about provenance or stability should have changed for this fixture.
    expect(report.provenanceChanges).toEqual([]);
    expect(report.stabilityChanges).toEqual([]);
    expect(report.abstractionChurnMerges).toEqual([]);
  });

  it("reports a demotion-driven rekey as abstraction churn, not as lost states", async () => {
    // Baseline: literalDomainLimit generous enough (default 8) that
    // Counter's `value` hook (domain size 6: 0..5) stays literal, so each
    // value is its own baseline state.
    const baselineRun = await exploreComponent({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      props: exampleProps,
      sourcePath: bench("counter/Counter.tsx"),
    });
    expect(baselineRun.demotedHooks).toEqual([]); // sanity: value is literal in the baseline run
    const baseline = buildBaseline(baselineRun);
    expect(baseline.states.length).toBeGreaterThan(2); // several distinct value states, not yet bucketed

    // Later run: literalDomainLimit forced very low, so `value`'s 6-value
    // domain exceeds it and gets demoted to M2's sign-and-zero bucket
    // (zero/positive/negative) mid-run -- exactly the scenario
    // docs/m2-5-adaptive-report.md warns retroactively merges previously-
    // distinct states.
    const laterRun = await exploreComponent({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      props: exampleProps,
      sourcePath: bench("counter/Counter.tsx"),
      abstraction: { literalDomainLimit: 2 },
    });
    expect(laterRun.demotedHooks).toContain("value"); // sanity: demotion actually happened this run

    const report = diffAgainstBaseline(baseline, laterRun);

    // The component did not change between these two runs -- only the
    // abstraction's literalDomainLimit did. A correct diff must not report
    // this as a real regression.
    expect(report.lostStates).toEqual([]);
    expect(report.abstractionChurnMerges.length).toBeGreaterThan(0);
    // The merge group should name more than one baseline state (several
    // distinct "value" literals collapsing into the same "positive"/"zero" bucket).
    expect(report.abstractionChurnMerges.some((m) => m.mergedBaselineStates.length > 1)).toBe(true);
  });
});
