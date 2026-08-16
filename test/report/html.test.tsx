/**
 * M5 Deliverable B smoke test: the HTML report renders as a single
 * self-contained document (no external URLs), embeds mermaid inline, and
 * includes the required sections for both single- and multi-assignment
 * results.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

import { exploreComponent } from "../../src/explore/engine.js";
import { exploreMultiAssignment } from "../../src/props/explore.js";
import { propsToArbitraries } from "../../src/props/propsToArbitraries.js";
import { renderExplorationHtml, renderMultiAssignmentHtml, buildMermaidSource } from "../../src/report/html.js";
import { Toggle } from "../../benchmarks/toggle/Toggle.js";
import { Counter } from "../../benchmarks/counter/Counter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(p: string) {
  return path.join(repoRoot, "benchmarks", p);
}

// A vendored library's bundled comments may legitimately mention a URL
// (license headers, "see github.com/..."). What must never appear is an
// element that causes the browser to *fetch* something: a <script src=...>,
// a <link href=...> stylesheet/font, an <img src="http...">, or a fetch/XHR
// call to an absolute URL.
function assertNoExternalRequests(html: string) {
  expect(html).not.toMatch(/<script[^>]+src\s*=/i);
  expect(html).not.toMatch(/<link[^>]+href/i);
  expect(html).not.toMatch(/<img[^>]+src\s*=\s*["']https?:/i);
  expect(html).not.toMatch(/\bfetch\(\s*["']https?:/i);
}

describe("report/html", () => {
  it("renders a single-assignment report with all required sections and no external requests", async () => {
    const result = await exploreComponent({
      componentName: "Toggle",
      render: (props) => <Toggle {...(props as any)} />,
      props: { label: "Power" },
      sourcePath: bench("toggle/Toggle.tsx"),
    });
    const html = renderExplorationHtml(result);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>");
    expect(html).toContain("State diagram");
    expect(html).toContain("State table");
    expect(html).toContain("Findings");
    expect(html).toContain("Budget usage");
    expect(html).toContain("class=\"mermaid\"");
    assertNoExternalRequests(html);
  });

  it("renders a multi-assignment report with the prop-analysis section", async () => {
    const { arbitraries } = propsToArbitraries({ sourcePath: bench("counter/Counter.tsx"), componentName: "Counter" });
    const multi = await exploreMultiAssignment({
      componentName: "Counter",
      render: (props) => <Counter {...(props as any)} />,
      sourcePath: bench("counter/Counter.tsx"),
      exampleProps: { min: 0, max: 5, start: 0 },
      arbitraries,
      sampleCount: 2,
      varyPerProp: 1,
      seed: 42,
    });
    const html = renderMultiAssignmentHtml(multi);
    expect(html).toContain("Prop analysis");
    expect(html).toContain("Responsible props");
    expect(html).toContain("Distinct graph shapes");
    assertNoExternalRequests(html);
  });

  it("buildMermaidSource marks a graph above the threshold as large", () => {
    const states = Array.from({ length: 35 }, (_, i) => ({
      id: `s${i}`,
      key: `s${i}`,
      fields: {},
      provenance: "default-props" as const,
      witness: { props: {}, actions: [] },
    }));
    const { large } = buildMermaidSource({ states, edges: [] });
    expect(large).toBe(true);
  });
});
