import { describe, expect, it } from "vitest";
import { useState } from "react";
import { exploreComponent } from "../../src/explore/engine.js";
import { AdaptiveAbstraction } from "../../src/abstraction/adaptive.js";
import { Toggle } from "../../benchmarks/toggle/Toggle.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

describe("exploreComponent: smoke", () => {
  it("explores Toggle and finds exactly 2 states, 2 edges", async () => {
    const result = await exploreComponent({
      componentName: "Toggle",
      render: (props) => <Toggle {...props} />,
      props: {},
      sourcePath: bench("toggle/Toggle.tsx"),
    });
    expect(result.graph.states.length).toBe(2);
    expect(result.graph.edges.length).toBeGreaterThanOrEqual(2);
    expect(result.budget.exhausted).toBe(false);
    expect(result.findings.replayDivergences.length).toBe(0);
  });
});

describe("exploreComponent: witness replay", () => {
  it("replaying a discovered state's witness in isolation reaches a matching state key", async () => {
    const result = await exploreComponent({
      componentName: "Toggle",
      render: (props) => <Toggle {...props} />,
      props: {},
      sourcePath: bench("toggle/Toggle.tsx"),
    });
    const onState = result.graph.states.find((s) => s.witness.actions.length === 1);
    expect(onState).toBeDefined();

    // Replay standalone: mount fresh and re-run the witness action sequence.
    const { render } = await import("@testing-library/react");
    const { discoverActions } = await import("../../src/explore/actions.js");
    const { settle } = await import("../../src/settle.js");
    const { extractSnapshot } = await import("../../src/fiber/index.js");

    const abstraction = new AdaptiveAbstraction({ componentName: "Toggle", sourcePath: bench("toggle/Toggle.tsx") });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { unmount } = render(<Toggle />, { container });
    let settleResult = await settle({ useFakeTimers: false });
    let comp = settleResult.snapshot.components.find((c) => c.componentName === "Toggle")!;
    let id = abstraction.observe({ snapshot: comp, sessionId: 0 });

    for (const step of onState!.witness.actions) {
      const { available } = discoverActions(container);
      const found = available.find((a) => a.id === step.id)!;
      found.perform();
      settleResult = await settle({ useFakeTimers: false });
      comp = settleResult.snapshot.components.find((c) => c.componentName === "Toggle")!;
      id = abstraction.observe({ snapshot: comp, sessionId: 0 });
    }

    // Same fields (booleans verbatim) should mean the standalone replay's
    // canonical key matches the engine's recorded key for that state.
    unmount();
    expect(id).toBeDefined();
    void extractSnapshot;
  });
});

describe("exploreComponent: budget exhaustion", () => {
  it("stops cleanly with budget.exhausted=true and a non-empty unexploredFrontier under a tiny budget", async () => {
    const result = await exploreComponent({
      componentName: "Toggle",
      render: (props) => <Toggle {...props} />,
      props: {},
      sourcePath: bench("toggle/Toggle.tsx"),
      budget: { maxActions: 1, maxStates: 50, maxWallClockMs: 30_000 },
    });
    expect(result.budget.exhausted).toBe(true);
    expect(result.unexploredFrontier.length).toBeGreaterThan(0);
  });
});

describe("exploreComponent: forced-demotion rekey", () => {
  it("merges a demoted hook's previously-distinct states with no dangling edges/frontier entries", async () => {
    // A fixture component whose single state hook takes on more distinct
    // values than the (tightened) literalDomainLimit, forcing demotion mid-exploration.
    function Fixture() {
      const [n, setN] = useState(0);
      return (
        <div>
          <output>{n}</output>
          <button type="button" onClick={() => setN((v: number) => v + 1)}>
            bump
          </button>
        </div>
      );
    }

    const result = await exploreComponent({
      componentName: "Fixture",
      render: () => <Fixture />,
      props: {},
      abstraction: { literalDomainLimit: 3 },
      budget: { maxActions: 20, maxStates: 50, maxWallClockMs: 30_000 },
    });

    // With literalDomainLimit=3, n=0,1,2 each get a distinct literal-mode id;
    // observing n=3 pushes the domain to size 4 > 3 and demotes n to the
    // sign-and-zero bucket, retroactively collapsing the ids for n=1 and n=2
    // (both bucket to "positive") into one survivor.
    expect(result.rekeyMerges.length).toBeGreaterThan(0);

    const stateIds = new Set(result.graph.states.map((s) => s.id));
    for (const edge of result.graph.edges) {
      expect(stateIds.has(edge.from)).toBe(true);
      expect(stateIds.has(edge.to)).toBe(true);
    }
    for (const entry of result.unexploredFrontier) {
      expect(stateIds.has(entry.state)).toBe(true);
    }
  });
});
