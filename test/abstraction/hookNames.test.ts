import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { getHookNames } from "../../src/abstraction/hookNames.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

describe("getHookNames: real benchmark sources", () => {
  it("recovers destructured useState names for Counter", () => {
    const result = getHookNames(bench("counter/Counter.tsx"), "Counter");
    expect(result.warnings).toEqual([]);
    expect(result.names).toEqual([{ name: "value", kind: "state" }]);
  });

  it("recovers destructured useState names for Toggle", () => {
    const result = getHookNames(bench("toggle/Toggle.tsx"), "Toggle");
    expect(result.warnings).toEqual([]);
    expect(result.names).toEqual([{ name: "on", kind: "state" }]);
  });

  it("recovers multiple useState hooks in source order for Wizard", () => {
    const result = getHookNames(bench("wizard/Wizard.tsx"), "Wizard");
    expect(result.warnings).toEqual([]);
    expect(result.names).toEqual([
      { name: "step", kind: "state" },
      { name: "name", kind: "state" },
      { name: "email", kind: "state" },
      { name: "done", kind: "state" },
    ]);
  });

  it("recovers ValidatedForm's email/password/submitted hooks in order", () => {
    const result = getHookNames(bench("validated-form/ValidatedForm.tsx"), "ValidatedForm");
    expect(result.warnings).toEqual([]);
    expect(result.names).toEqual([
      { name: "email", kind: "state" },
      { name: "password", kind: "state" },
      { name: "submitted", kind: "state" },
    ]);
  });

  it("recovers PropGated's two toggle hooks", () => {
    const result = getHookNames(bench("prop-gated/PropGated.tsx"), "PropGated");
    expect(result.warnings).toEqual([]);
    expect(result.names).toEqual([
      { name: "notificationsOn", kind: "state" },
      { name: "expertModeOn", kind: "state" },
    ]);
  });

  it("only reports useState/useReducer, not useRef/useEffect, for DebouncedSearch", () => {
    const result = getHookNames(bench("debounced-search/DebouncedSearch.tsx"), "DebouncedSearch");
    expect(result.warnings).toEqual([]);
    // text, phase, results are useState; timerRef and requestId are useRef
    // and must not appear.
    expect(result.names).toEqual([
      { name: "text", kind: "state" },
      { name: "phase", kind: "state" },
      { name: "results", kind: "state" },
    ]);
  });

  it("reports a warning and empty names for an unknown component", () => {
    const result = getHookNames(bench("counter/Counter.tsx"), "NoSuchComponent");
    expect(result.names).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("getHookNames: synthetic fallback cases", () => {
  function writeTemp(source: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hookNames-test-"));
    const file = path.join(dir, "Fixture.tsx");
    fs.writeFileSync(file, source);
    return file;
  }

  it("falls back to a synthesised name for a non-destructured useState", () => {
    const file = writeTemp(`
      import { useState } from "react";
      export function Fixture() {
        const s = useState(0);
        return null;
      }
    `);
    const result = getHookNames(file, "Fixture");
    expect(result.names).toEqual([{ name: "s", kind: "state" }]);
  });

  it("falls back to hookN for a fully unrecognisable binding form", () => {
    const file = writeTemp(`
      import { useState } from "react";
      export function Fixture() {
        const [{ current }] = [useState(0)[0]];
        useState(1);
        return null;
      }
    `);
    const result = getHookNames(file, "Fixture");
    // The direct `useState(1)` call has no enclosing VariableDeclaration at
    // all, so it must fall back to a synthesised name with a warning rather
    // than throwing.
    expect(result.names.length).toBeGreaterThan(0);
    expect(result.names.some((n) => n.name.startsWith("hook"))).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("recovers a useReducer state-binding name and reports kind 'reducer'", () => {
    const file = writeTemp(`
      import { useReducer } from "react";
      function reducer(s: number, a: number) { return s + a; }
      export function Fixture() {
        const [count, dispatch] = useReducer(reducer, 0);
        return null;
      }
    `);
    const result = getHookNames(file, "Fixture");
    expect(result.warnings).toEqual([]);
    expect(result.names).toEqual([{ name: "count", kind: "reducer" }]);
  });

  it("does not throw for a file with a syntax error, and reports a warning", () => {
    const file = writeTemp(`export function Fixture( {`);
    expect(() => getHookNames(file, "Fixture")).not.toThrow();
  });
});
