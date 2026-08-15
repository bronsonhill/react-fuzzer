import { describe, expect, it } from "vitest";
import fc from "fast-check";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { propsToArbitraries } from "../../src/props/propsToArbitraries.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

describe("propsToArbitraries", () => {
  it("maps PropGated's mode: 'simple' | 'advanced' to fc.constantFrom over exactly those two literals", () => {
    const { arbitraries, inferred, overridden } = propsToArbitraries({
      sourcePath: bench("prop-gated/PropGated.tsx"),
      componentName: "PropGated",
    });
    expect(inferred).toEqual(["mode"]);
    expect(overridden).toEqual([]);
    const samples = fc.sample(arbitraries.mode!, { numRuns: 50 });
    expect(new Set(samples)).toEqual(new Set(["simple", "advanced"]));
  });

  it("maps Counter's optional numeric props to bounded integers wrapped in fc.option", () => {
    const { arbitraries, inferred } = propsToArbitraries({
      sourcePath: bench("counter/Counter.tsx"),
      componentName: "Counter",
    });
    expect(new Set(inferred)).toEqual(new Set(["min", "max", "start"]));
    const samples = fc.sample(arbitraries.min!, { numRuns: 30 });
    for (const s of samples) {
      expect(s === undefined || typeof s === "number").toBe(true);
    }
  });

  it("maps Toggle's optional string prop to fc.option(fc.string)", () => {
    const { arbitraries, inferred } = propsToArbitraries({
      sourcePath: bench("toggle/Toggle.tsx"),
      componentName: "Toggle",
    });
    expect(inferred).toEqual(["label"]);
    const samples = fc.sample(arbitraries.label!, { numRuns: 30 });
    for (const s of samples) {
      expect(s === undefined || typeof s === "string").toBe(true);
    }
  });

  it("throws naming the prop for FetchList's fetchItems (function type) with no override supplied", () => {
    expect(() =>
      propsToArbitraries({
        sourcePath: bench("fetch-list/FetchList.tsx"),
        componentName: "FetchList",
      }),
    ).toThrowError(/fetchItems/);
  });

  it("throws naming the prop for DebouncedSearch's query (function type) with no override supplied", () => {
    expect(() =>
      propsToArbitraries({
        sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
        componentName: "DebouncedSearch",
      }),
    ).toThrowError(/query/);
  });

  it("accepts an explicit override for a function-typed prop and bypasses inference for it, reporting it as overridden not inferred", () => {
    const { arbitraries, inferred, overridden } = propsToArbitraries({
      sourcePath: bench("fetch-list/FetchList.tsx"),
      componentName: "FetchList",
      propOverrides: { fetchItems: fc.constant(() => Promise.resolve([])) },
    });
    expect(overridden).toEqual(["fetchItems"]);
    expect(inferred).toEqual([]);
    expect(typeof fc.sample(arbitraries.fetchItems!, 1)[0]).toBe("function");
  });

  it("throws naming the prop for Wizard's onComplete (function type) with no override supplied", () => {
    expect(() =>
      propsToArbitraries({
        sourcePath: bench("wizard/Wizard.tsx"),
        componentName: "Wizard",
      }),
    ).toThrowError(/onComplete/);
  });

  it("throws naming the prop for ValidatedForm's onSubmit (function type) with no override supplied", () => {
    expect(() =>
      propsToArbitraries({
        sourcePath: bench("validated-form/ValidatedForm.tsx"),
        componentName: "ValidatedForm",
      }),
    ).toThrowError(/onSubmit/);
  });
});
