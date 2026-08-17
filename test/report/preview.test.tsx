/**
 * State previews (docs/state-preview-proposal.md, Option 1): the engine
 * stores the markup each state rendered, and the HTML report shows it in a
 * hover card.
 *
 * The two properties worth pinning down are that *every* state gets one
 * (transient states included -- they are the ones no live re-render could
 * ever reach), and that the stored markup is deterministic, since the JSON
 * artefact now carries it and test/report/json.test.tsx requires two runs
 * of the same component to be byte-identical.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureMarkup } from "../../src/abstraction/domSnapshot.js";
import { exploreComponent } from "../../src/explore/engine.js";
import { renderExplorationHtml } from "../../src/report/html.js";
import { ValidatedForm } from "../../benchmarks/validated-form/ValidatedForm.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const formSource = path.join(repoRoot, "benchmarks/validated-form/ValidatedForm.tsx");
const fetchListSource = path.join(repoRoot, "benchmarks/fetch-list/FetchList.tsx");

const fillPools = (field: { name: string }) => {
  if (/email/i.test(field.name)) return ["", "ada@example.com"];
  if (/password/i.test(field.name)) return ["", "longenough1"];
  return undefined;
};

function exploreForm() {
  return exploreComponent({
    componentName: "ValidatedForm",
    render: (props) => <ValidatedForm {...(props as any)} />,
    props: { onSubmit: undefined },
    sourcePath: formSource,
    fillPools,
  });
}

/** FetchList is the transient-heavy case: its loading state exists only mid-flight. */
function exploreFetchList() {
  const items: Item[] = [{ id: "1", label: "One" }];
  return exploreComponent({
    componentName: "FetchList",
    render: (props) => <FetchList {...(props as any)} />,
    props: { fetchItems: () => Promise.resolve(items) },
    sourcePath: fetchListSource,
    settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
    invokableProps: {},
  });
}

describe("abstraction/domSnapshot: captureMarkup", () => {
  function container(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  it("reflects live form state that innerHTML would drop", () => {
    const el = container(`<input type="text" /><input type="checkbox" />`);
    const inputs = Array.from(el.querySelectorAll("input"));
    const text = inputs[0]!;
    const box = inputs[1]!;
    text.value = "typed by the fuzzer";
    box.checked = true;

    // innerHTML alone shows neither: both are properties, not attributes.
    expect(el.innerHTML).not.toContain("typed by the fuzzer");

    const markup = captureMarkup(el);
    expect(markup).toContain(`value="typed by the fuzzer"`);
    expect(markup).toContain("checked");
  });

  it("drops React-internal attributes and sorts the rest", () => {
    const el = container(`<button zeta="1" alpha="2">Go</button>`);
    const button = el.querySelector("button")!;
    // React's own internals are stored as DOM *properties* with a `$`-suffixed
    // key, which setAttribute rejects outright; data-reactroot is the
    // attribute form that actually reaches innerHTML.
    button.setAttribute("data-reactroot", "");
    button.setAttribute("__reactFiber", "{}");

    const markup = captureMarkup(el);
    expect(markup).not.toContain("__react");
    expect(markup).not.toContain("data-reactroot");
    expect(markup).toBe(`<button alpha="2" zeta="1">Go</button>`);
  });

  it("escapes text content rather than emitting it raw", () => {
    const el = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = `<script>alert("x")</script>`;
    el.appendChild(p);
    expect(captureMarkup(el)).toBe(`<p>&lt;script&gt;alert("x")&lt;/script&gt;</p>`);
  });
});

describe("report: state previews", () => {
  it("captures markup for every state, transient states included", async () => {
    const result = await exploreFetchList();
    const withoutHtml = result.graph.states.filter((s) => s.html === undefined);
    expect(withoutHtml.map((s) => s.key)).toEqual([]);

    // Sanity: this component does produce transient states, so the above is
    // not passing on settled states alone.
    expect(result.graph.states.some((s) => s.transient)).toBe(true);
    const transient = result.graph.states.filter((s) => s.transient);
    expect(transient.every((s) => (s.html as string).length > 0)).toBe(true);
  });

  it("captures the same markup across two independent runs", async () => {
    const a = await exploreForm();
    const b = await exploreForm();
    const markupOf = (r: typeof a) =>
      [...r.graph.states].sort((x, y) => x.key.localeCompare(y.key)).map((s) => `${s.key}::${s.html}`);
    expect(markupOf(a)).toEqual(markupOf(b));
  });

  it("embeds previews in the report as sandboxed iframe content, with no external requests", async () => {
    const result = await exploreForm();
    const html = renderExplorationHtml(result);

    expect(html).toContain(`id="preview-card"`);
    expect(html).toContain(`<iframe sandbox=""`);
    expect(html).toContain("const PREVIEWS = ");
    // The payload must not be able to break out of the <script> that holds it.
    const payload = html.slice(html.indexOf("const PREVIEWS = "));
    expect(payload.slice(0, payload.indexOf("\n"))).not.toContain("</");
    expect(html).not.toMatch(/<script[^>]+src\s*=/i);
    expect(html).not.toMatch(/<link[^>]+href/i);
  });

  it("inlines a supplied stylesheet into the previews", async () => {
    const result = await exploreForm();
    const html = renderExplorationHtml(result, { previewStylesheet: ".field { color: rebeccapurple; }" });
    expect(html).toContain("rebeccapurple");
  });
});
