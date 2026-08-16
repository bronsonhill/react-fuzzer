/**
 * M5 Deliverable A test: two independent runs of the same component over
 * the same fixed props must serialise to byte-identical JSON, despite the
 * engine's internal Map/Set iteration order not being guaranteed to match
 * run to run and wall-clock timing varying between runs.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exploreComponent } from "../../src/explore/engine.js";
import { explorationResultToJson } from "../../src/report/json.js";
import { Wizard } from "../../benchmarks/wizard/Wizard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const wizardSource = path.join(repoRoot, "benchmarks/wizard/Wizard.tsx");

describe("report/json: determinism", () => {
  it("two independent explorations of the same component produce byte-identical JSON", async () => {
    const run = () =>
      exploreComponent({
        componentName: "Wizard",
        render: (props) => <Wizard {...(props as any)} />,
        props: { onComplete: undefined },
        sourcePath: wizardSource,
        fillPools: (field) => {
          if (/name/i.test(field.name)) return ["", "Ada"];
          if (/email/i.test(field.name)) return ["", "ada@example.com"];
          return undefined;
        },
      });

    const resultA = await run();
    const resultB = await run();
    const jsonA = explorationResultToJson(resultA);
    const jsonB = explorationResultToJson(resultB);

    expect(jsonA).toBe(jsonB);
    // Sanity: the document actually has content, not two empty runs agreeing trivially.
    expect(resultA.graph.states.length).toBeGreaterThan(1);
  });
});
