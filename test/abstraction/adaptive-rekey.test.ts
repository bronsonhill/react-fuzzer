/**
 * Unit-level checks for AdaptiveAbstraction's rekey mechanism (M2.5
 * Deliverable A), independent of any real component. Constructs
 * ComponentSnapshot values directly so the demotion and DOM-pruning paths
 * can be exercised precisely, including the merge case that a real
 * benchmark run may or may not happen to trigger.
 */
import { describe, expect, it } from "vitest";
import type { ComponentSnapshot } from "../../src/fiber/index.js";
import { AdaptiveAbstraction, type RekeyMerge } from "../../src/abstraction/adaptive.js";

function snap(value: string | number): ComponentSnapshot {
  return {
    componentName: "Fixture",
    path: "Fixture",
    hooks: [{ index: 0, kind: "state", value }],
  };
}

describe("AdaptiveAbstraction: demotion-triggered rekey", () => {
  it("merges previously-distinct literal-mode ids once the domain exceeds literalDomainLimit", () => {
    const abstraction = new AdaptiveAbstraction({ componentName: "Fixture", literalDomainLimit: 3 });
    const merges: RekeyMerge[] = [];
    abstraction.onRekey((m) => merges.push(...m));

    // Three distinct literal values: three distinct ids (domain size 3, at the limit).
    const idA = abstraction.observe({ snapshot: snap("a") });
    const idB = abstraction.observe({ snapshot: snap("b") });
    const idC = abstraction.observe({ snapshot: snap("c") });
    expect(new Set([idA, idB, idC]).size).toBe(3);
    expect(abstraction.getDemotedHooks()).toEqual([]);

    // A fourth distinct value pushes the domain to 4 > limit (3): hook0
    // demotes to the bucket rule, and every prior string value buckets to
    // the same "nonEmpty" token, so all four ids that were previously
    // distinct collapse into one.
    const idD = abstraction.observe({ snapshot: snap("d") });
    expect(abstraction.getDemotedHooks()).toEqual(["hook0"]);
    expect(merges.length).toBeGreaterThan(0);

    const mergedAway = new Set(merges.flatMap((m) => m.from));
    const survivors = new Set([idA, idB, idC, idD].filter((id) => !mergedAway.has(id)));
    expect(survivors.size).toBe(1); // all four collapsed to one id
  });
});

describe("AdaptiveAbstraction: DOM-correlation-triggered rekey", () => {
  it("merges ids that previously differed only in a hook later pruned as DOM-invisible", () => {
    const abstraction = new AdaptiveAbstraction({
      componentName: "Fixture",
      domCorrelation: { minObservations: 2 },
    });
    const merges: RekeyMerge[] = [];
    abstraction.onRekey((m) => merges.push(...m));

    function snapTwo(shown: string, hidden: number): ComponentSnapshot {
      return {
        componentName: "Fixture",
        path: "Fixture",
        hooks: [
          { index: 0, kind: "state", value: shown },
          { index: 1, kind: "state", value: hidden },
        ],
      };
    }

    // `shown` always renders as itself in the (fake) DOM fingerprint;
    // `hidden` never affects it. Two observations with the same `shown` but
    // different `hidden` are, before pruning kicks in, two distinct ids.
    const id1 = abstraction.observe({ snapshot: snapTwo("x", 0), domFingerprint: "dom:x" });
    const id2 = abstraction.observe({ snapshot: snapTwo("x", 1), domFingerprint: "dom:x" }); // hidden varies, dom doesn't (evidence #1)
    expect(id1).not.toBe(id2); // not yet pruned (only 1 piece of evidence)

    const id3 = abstraction.observe({ snapshot: snapTwo("x", 2), domFingerprint: "dom:x" }); // evidence #2 -> prune threshold met
    expect(abstraction.getDomPruneReport().find((r) => r.hookName === "hook1")?.pruned).toBe(true);
    expect(merges.length).toBeGreaterThan(0);

    const mergedAway = new Set(merges.flatMap((m) => m.from));
    const survivors = new Set([id1, id2, id3].filter((id) => !mergedAway.has(id)));
    expect(survivors.size).toBe(1);
  });

  it("does not prune a hook that co-varies with the DOM even once, in isolation", () => {
    const abstraction = new AdaptiveAbstraction({
      componentName: "Fixture",
      domCorrelation: { minObservations: 2 },
    });

    function snapTwo(shown: number, hidden: number): ComponentSnapshot {
      return {
        componentName: "Fixture",
        path: "Fixture",
        hooks: [
          { index: 0, kind: "state", value: shown },
          { index: 1, kind: "state", value: hidden },
        ],
      };
    }

    // hidden varies with no DOM change twice (would-be prune evidence)...
    abstraction.observe({ snapshot: snapTwo(0, 0), domFingerprint: "dom:0" });
    abstraction.observe({ snapshot: snapTwo(0, 1), domFingerprint: "dom:0" });
    abstraction.observe({ snapshot: snapTwo(0, 2), domFingerprint: "dom:0" });
    // ...but then, in an isolated transition (only hidden changes), the DOM
    // also changes: disqualifying evidence that must override the earlier count.
    abstraction.observe({ snapshot: snapTwo(0, 3), domFingerprint: "dom:1" });

    const report = abstraction.getDomPruneReport().find((r) => r.hookName === "hook1");
    expect(report?.everCoVaried).toBe(true);
    expect(report?.pruned).toBe(false);
  });
});
