/**
 * M5 Deliverable B: single self-contained HTML report. No external
 * requests of any kind -- Mermaid is loaded from a locally installed copy
 * bundled inline as a <script> tag (see loadMermaidSource below), all CSS
 * is inline, no remote fonts or images.
 *
 * Renders either a single-assignment ExplorationResult or a merged
 * MultiAssignmentResult (which additionally gets the prop-analysis
 * section). See docs/poc-plan.md's M5 section for the required contents.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExplorationResult, StateNode, Edge, ActionRef } from "../explore/graph.js";
import type { MultiAssignmentResult } from "../props/explore.js";
import { collapseTransientChains, isCollapsedEdge, type CollapsedEdge } from "./collapse.js";

const MERMAID_NODE_THRESHOLD = 30;

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Mermaid state-diagram-safe node id: strip anything that would break the syntax. */
function mermaidId(id: string): string {
  return `n_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function mermaidLabel(state: StateNode): string {
  const fieldStr = Object.entries(state.fields)
    .map(([k, v]) => `${k}=${jsonShort(v)}`)
    .join(", ");
  const tags = [state.transient ? "transient" : null, state.provenance === "generated-props" ? "generated" : null]
    .filter(Boolean)
    .join(",");
  const suffix = tags ? ` [${tags}]` : "";
  const text = `${state.key}${fieldStr ? ": " + fieldStr : ""}${suffix}`;
  // Mermaid state labels: quote and escape internal quotes; keep on one line.
  return text.replace(/"/g, "'").slice(0, 160);
}

function jsonShort(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 24 ? s.slice(0, 21) + "..." : (s ?? "undefined");
  } catch {
    return String(v);
  }
}

function edgeLabel(e: Edge | CollapsedEdge): string {
  if (e.kind === "collapsed") {
    const base = e.action?.label ?? e.action?.id ?? "action";
    return e.via.length > 0 ? `${base} (via ${e.via.join(", ")})` : base;
  }
  if (e.kind === "user") return e.action?.label ?? e.action?.id ?? "action";
  return `auto:${e.driver ?? "?"}`;
}

/**
 * Builds the mermaid `stateDiagram-v2` source. Provenance and transience
 * are shown via mermaid classDef styling (assigned per-node with `class`
 * statements); user vs auto edges and their driver are shown via the edge
 * label itself, since mermaid state diagrams don't support per-edge CSS
 * classes the way flowcharts do; unstable/non-deterministic edges get a
 * `[!]`/`[?]` marker prefix in their label for the same reason.
 */
export function buildMermaidSource(graph: {
  states: StateNode[];
  edges: Array<Edge | CollapsedEdge>;
}): { source: string; large: boolean } {
  const lines: string[] = ["stateDiagram-v2"];
  const sortedStates = [...graph.states].sort((a, b) => a.key.localeCompare(b.key));
  const sortedEdges = [...graph.edges].sort((a, b) => {
    const ak = e2k(a);
    const bk = e2k(b);
    return ak.localeCompare(bk);
  });
  function e2k(e: Edge | CollapsedEdge): string {
    if (e.kind === "collapsed") return `${e.from}::${e.action.id}::${e.to}`;
    return `${e.from}::${e.kind === "user" ? e.action?.id : e.driver}::${e.to}`;
  }

  for (const s of sortedStates) {
    lines.push(`  ${mermaidId(s.id)} : ${mermaidLabel(s)}`);
  }
  for (const s of sortedStates) {
    const cls: string[] = [];
    cls.push(s.provenance === "generated-props" ? "generatedProps" : "defaultProps");
    if (s.transient) cls.push("transientState");
    lines.push(`  class ${mermaidId(s.id)} ${cls.join(",")}`);
  }
  for (const e of sortedEdges) {
    let label = edgeLabel(e);
    // Mermaid state diagrams don't support per-edge CSS classes the way
    // flowcharts do (only node classDef), so provenance and stability on
    // an *edge* are shown as label prefixes instead of color/dashing.
    if (e.provenance === "generated-props") label = `[gen] ${label}`;
    if (!e.stable) label = `[unstable] ${label}`;
    if (e.kind !== "collapsed" && e.nonDeterministic) label = `[non-det] ${label}`;
    if (e.kind === "collapsed") label = `[collapsed] ${label}`;
    lines.push(`  ${mermaidId(e.from)} --> ${mermaidId(e.to)} : ${label.replace(/"/g, "'").slice(0, 120)}`);
  }
  lines.push(`  classDef defaultProps fill:#3b6fb0,color:#fff,stroke:#1c3a5e`);
  lines.push(`  classDef generatedProps fill:#8a5cc7,color:#fff,stroke:#4c2f75,stroke-dasharray: 3 2`);
  lines.push(`  classDef transientState stroke-dasharray: 2 2,opacity:0.75`);

  return { source: lines.join("\n"), large: sortedStates.length > MERMAID_NODE_THRESHOLD };
}

function witnessHtml(state: StateNode): string {
  const parts: string[] = [];
  parts.push(`<div class="witness-props"><strong>props:</strong> <code>${esc(safeJson(state.witness.props))}</code></div>`);
  if (state.witness.actions.length === 0) {
    parts.push(`<div class="witness-actions"><em>mount only, no actions</em></div>`);
  } else {
    parts.push(
      `<ol class="witness-actions">${state.witness.actions
        .map((a: ActionRef) => `<li>${esc(actionText(a))}</li>`)
        .join("")}</ol>`,
    );
  }
  if (state.witness.note) parts.push(`<div class="witness-note">${esc(state.witness.note)}</div>`);
  return parts.join("");
}

function actionText(a: ActionRef): string {
  let t = `${a.kind}: ${a.label}`;
  if (a.value !== undefined) t += ` = ${JSON.stringify(a.value)}`;
  if (a.optionValue !== undefined) t += ` -> ${a.optionValue}`;
  if (a.propName !== undefined) t += ` (prop ${a.propName})`;
  return t;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fieldsHtml(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) return "<em>none</em>";
  return keys.map((k) => `<code>${esc(k)}=${esc(safeJson(fields[k]))}</code>`).join("<br/>");
}

function stateTableRows(states: StateNode[], collapsedStateIds: Set<string>): string {
  return [...states]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(
      (s) => `
      <tr class="${s.provenance === "generated-props" ? "row-generated" : "row-default"}">
        <td><code${s.html !== undefined ? ` class="previewable" data-preview="${esc(s.id)}" tabindex="0" role="button" aria-expanded="false"` : ""}>${esc(s.key)}</code></td>
        <td>${esc(s.provenance)}</td>
        <td>${s.transient ? "yes" : "no"}</td>
        <td>${collapsedStateIds.has(s.id) ? "collapsed" : "shown"}</td>
        <td>${fieldsHtml(s.fields)}</td>
        <td>${witnessHtml(s)}</td>
      </tr>`,
    )
    .join("");
}

function findingsHtml(result: ExplorationResult): string {
  const { unstable, nonDeterministic, replayDivergences } = result.findings;
  const section = (title: string, empty: string, rows: string) => `
    <h3>${esc(title)}</h3>
    ${rows || `<p class="empty-note">${esc(empty)}</p>`}
  `;

  const unstableRows =
    unstable.length > 0
      ? `<ul>${unstable.map((e) => `<li><code>${esc(e.from)}</code> &rarr; <code>${esc(e.to)}</code> via ${esc(edgeLabel(e))}</li>`).join("")}</ul>`
      : "";
  const ndRows =
    nonDeterministic.length > 0
      ? `<ul>${nonDeterministic
          .map(
            (e) =>
              `<li><code>${esc(e.from)}</code> via ${esc(edgeLabel(e))} observed landing on: ${(e.nonDeterministic?.observedDestinations ?? [])
                .map((d) => `<code>${esc(d)}</code>`)
                .join(", ")}</li>`,
          )
          .join("")}</ul>`
      : "";
  const rdRows =
    replayDivergences.length > 0
      ? `<ul>${replayDivergences
          .map(
            (d) =>
              `<li>state <code>${esc(d.state)}</code>: expected <code>${esc(d.expectedId)}</code>, replay landed on <code>${esc(d.actualId)}</code></li>`,
          )
          .join("")}</ul>`
      : "";
  const pruneRows =
    result.domPruneReport.length > 0
      ? `<table class="prune-table"><thead><tr><th>hook</th><th>varied w/o DOM change</th><th>ever co-varied</th><th>pruned from identity</th></tr></thead><tbody>${result.domPruneReport
          .map(
            (p) =>
              `<tr class="${p.pruned ? "row-pruned" : ""}"><td><code>${esc(p.hookName)}</code></td><td>${p.variedNoDomCount}</td><td>${p.everCoVaried ? "yes" : "no"}</td><td>${p.pruned ? "yes" : "no"}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : "";

  return `
    <section id="findings">
      <h2>Findings</h2>
      ${section("Unstable transitions", "no unstable transitions were observed (settle() reached quiescence every time).", unstableRows)}
      ${section("Non-deterministic transitions", "no non-deterministic transitions were observed.", ndRows)}
      ${section("Replay divergences", "no replay divergences were observed.", rdRows)}
      ${section(
        "DOM-correlation-pruned hooks",
        "no hooks were pruned from state identity (every observed hook either co-varied with the DOM or was never flagged as a pruning candidate).",
        pruneRows,
      )}
    </section>
  `;
}

function propAnalysisHtml(multi: MultiAssignmentResult): string {
  const rows = multi.distinctShapes
    .map(
      (g) => `
      <tr class="${g.isExampleShape ? "row-default" : "row-generated"}">
        <td><code>${esc(g.shapeHash.slice(0, 12))}...</code></td>
        <td>${g.isExampleShape ? "yes" : "no"}</td>
        <td>${g.stateCount}</td>
        <td>${g.edgeCount}</td>
        <td>${g.assignments
          .map((a) => `<div><code>${esc(a.source)}${a.variedProp ? `:${esc(a.variedProp)}` : ""}</code> ${esc(safeJson(a.props))}</div>`)
          .join("")}</td>
      </tr>`,
    )
    .join("");

  const responsible =
    multi.responsibleProps.length > 0
      ? `<ul>${multi.responsibleProps
          .map((r) => `<li><code>${esc(r.prop)}</code> (${esc(r.confidence)}): ${esc(r.evidence)}</li>`)
          .join("")}</ul>`
      : `<p class="empty-note">no prop was identified as responsible for a graph-shape change.</p>`;

  return `
    <section id="prop-analysis">
      <h2>Prop analysis</h2>
      <p>${multi.runs.length} prop assignments sampled (1 example + ${multi.runs.length - 1} generated: one-prop-at-a-time and random).</p>
      <h3>Responsible props</h3>
      ${responsible}
      <h3>Distinct graph shapes</h3>
      <div class="table-scroll">
        <table>
          <thead><tr><th>shape</th><th>example shape?</th><th>states</th><th>edges</th><th>produced by</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function budgetHtml(result: ExplorationResult, elapsedMs: number): string {
  const b = result.budget;
  const frontier =
    result.unexploredFrontier.length > 0
      ? `<ul>${result.unexploredFrontier
          .slice(0, 200)
          .map((f) => `<li><code>${esc(f.state)}</code> untried: ${esc(actionText(f.action))}</li>`)
          .join("")}</ul>${result.unexploredFrontier.length > 200 ? `<p>...and ${result.unexploredFrontier.length - 200} more.</p>` : ""}`
      : `<p class="empty-note">none -- the frontier was fully explored within budget.</p>`;

  return `
    <section id="budget">
      <h2>Budget usage</h2>
      <table class="kv-table">
        <tbody>
          <tr><th>actions used</th><td>${b.actionsUsed}</td></tr>
          <tr><th>states found</th><td>${b.statesFound}</td></tr>
          <tr><th>elapsed</th><td>${elapsedMs.toFixed(0)}ms</td></tr>
          <tr><th>budget exhausted</th><td>${b.exhausted ? "yes" : "no"}</td></tr>
        </tbody>
      </table>
      <h3>Unexplored frontier</h3>
      ${frontier}
    </section>
  `;
}

let cachedMermaidSource: string | undefined;
function loadMermaidSource(): string {
  if (cachedMermaidSource) return cachedMermaidSource;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../node_modules/mermaid/dist/mermaid.min.js"),
    path.resolve(here, "../../node_modules/mermaid/dist/mermaid.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedMermaidSource = fs.readFileSync(c, "utf8");
      return cachedMermaidSource;
    }
  }
  throw new Error(
    "mermaid package not found in node_modules. `npm install mermaid` (a devDependency) is required to build the HTML report, " +
      "since the report inlines mermaid's source directly so the resulting page makes no external requests.",
  );
}

const CSS = `
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #5b6270;
  --border: #d7dbe0;
  --card-bg: #f7f8fa;
  --code-bg: #eef0f3;
  --accent: #3b6fb0;
  --warn-bg: #fff4e5;
  --warn-border: #e0a94a;
  --row-default: #eaf1fb;
  --row-generated: #f2ecfb;
  --row-pruned: #fff0f0;
  --link: #2456a6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161a;
    --fg: #e7e9ec;
    --muted: #9aa2ad;
    --border: #33383f;
    --card-bg: #1c1f24;
    --code-bg: #23262c;
    --accent: #7aa7e0;
    --warn-bg: #3a2f14;
    --warn-border: #b5872f;
    --row-default: #1c2a3d;
    --row-generated: #2a2137;
    --row-pruned: #3a1e1e;
    --link: #8ab4f8;
  }
}
:root[data-theme="dark"] {
  --bg: #14161a;
  --fg: #e7e9ec;
  --muted: #9aa2ad;
  --border: #33383f;
  --card-bg: #1c1f24;
  --code-bg: #23262c;
  --accent: #7aa7e0;
  --warn-bg: #3a2f14;
  --warn-border: #b5872f;
  --row-default: #1c2a3d;
  --row-generated: #2a2137;
  --row-pruned: #3a1e1e;
  --link: #8ab4f8;
}
* { box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  margin: 0;
  padding: 1.5rem 2rem 4rem;
  max-width: 68rem;
  margin-inline: auto;
}
h1, h2, h3 { line-height: 1.25; }
h1 { font-size: 1.6rem; }
h2 { font-size: 1.25rem; margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
h3 { font-size: 1.05rem; margin-top: 1.5rem; color: var(--muted); }
code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
.subtitle { color: var(--muted); margin-top: -0.5rem; }
.badge {
  display: inline-block; padding: 0.15em 0.6em; border-radius: 999px; font-size: 0.8em;
  border: 1px solid var(--border); margin-right: 0.4em;
}
.badge-default { background: var(--row-default); }
.badge-generated { background: var(--row-generated); }
.incomplete-banner {
  background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 6px;
  padding: 0.75rem 1rem; font-weight: 600; margin-bottom: 1.5rem;
}
.large-graph-warning {
  background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 6px;
  padding: 0.6rem 1rem; margin-bottom: 1rem; font-size: 0.92rem;
}
.legend { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; font-size: 0.88rem; color: var(--muted); margin: 0.75rem 0 1rem; }
.legend span.swatch { display: inline-block; width: 0.85em; height: 0.85em; border-radius: 3px; margin-right: 0.35em; vertical-align: middle; }
.sw-default { background: #3b6fb0; }
.sw-generated { background: #8a5cc7; }
.sw-transient { background: #808080; opacity: 0.75; }
.mermaid-container { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; background: var(--card-bg); }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
th, td { border: 1px solid var(--border); padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; font-size: 0.92rem; }
th { background: var(--card-bg); }
tr.row-default { background: color-mix(in srgb, var(--row-default) 55%, var(--bg)); }
tr.row-generated { background: color-mix(in srgb, var(--row-generated) 55%, var(--bg)); }
tr.row-pruned { background: color-mix(in srgb, var(--row-pruned) 55%, var(--bg)); }
.kv-table th { width: 12rem; }
.empty-note { color: var(--muted); font-style: italic; }
.witness-props { margin-bottom: 0.3rem; font-size: 0.85rem; }
.witness-actions { margin: 0; padding-left: 1.1rem; }
.witness-note { color: var(--muted); font-size: 0.85rem; margin-top: 0.3rem; }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--border); padding-top: 1rem; }
a { color: var(--link); }
code.previewable { cursor: pointer; border-bottom: 1px dotted var(--accent); }
code.previewable:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
code.previewable[aria-expanded="true"] { background: var(--accent); color: var(--bg); }
.mermaid g[data-previewable] { cursor: pointer; }
.mermaid g[data-previewable][aria-expanded="true"] rect,
.mermaid g[data-previewable][aria-expanded="true"] polygon,
.mermaid g[data-previewable][aria-expanded="true"] circle { stroke: var(--accent); stroke-width: 3px; }

/* The side pane: fixed to the right edge, full height, off-screen until a
   state is picked. Wide viewports also shift the (max-width, centred) body
   left by the pane's width so the pane never covers the table you clicked
   from; below 90rem there isn't room for that, and it overlays instead. */
#preview-pane {
  position: fixed; z-index: 50; top: 0; right: 0; bottom: 0;
  width: min(34rem, 92vw);
  display: flex; flex-direction: column;
  background: var(--bg); border-left: 1px solid var(--border);
  box-shadow: -6px 0 24px rgba(0, 0, 0, 0.28);
  transform: translateX(100%); transition: transform 0.15s ease-out;
}
#preview-pane[data-open] { transform: translateX(0); }
#preview-pane .preview-head {
  display: flex; align-items: baseline; gap: 0.5rem;
  padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); background: var(--card-bg);
}
#preview-pane .preview-title { font-size: 0.85rem; font-weight: 600; overflow-wrap: anywhere; }
#preview-pane .preview-note { font-size: 0.78rem; color: var(--muted); }
#preview-pane .preview-close {
  margin-left: auto; flex: none; cursor: pointer;
  background: none; border: 1px solid var(--border); border-radius: 4px;
  color: var(--fg); font-size: 0.9rem; line-height: 1; padding: 0.25rem 0.45rem;
}
#preview-pane iframe { display: block; flex: 1 1 auto; width: 100%; border: 0; background: var(--bg); }
@media (min-width: 90rem) {
  body.preview-open { margin-right: min(34rem, 92vw); }
}
`;

/**
 * Base styles injected into every preview iframe, before any user-supplied
 * stylesheet so the latter can override them. `color-scheme` plus the
 * Canvas/CanvasText system colours make the preview follow the reader's
 * theme without the report's own palette leaking in (which is the whole
 * reason this is an iframe and not a div).
 */
const PREVIEW_BASE_CSS = `
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { padding: 8px; background: Canvas; color: CanvasText; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
img { max-width: 100%; }
`;

/** JSON for embedding in a <script> body: `<` escaped so nothing can close the tag early. */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The state-preview payload and side-pane behaviour. Clicking a state key
 * (or a diagram node) opens a right-hand pane holding an iframe; clicking
 * the same trigger again, the close button, or Escape shuts it. Previews
 * are stored
 * markup captured during exploration (src/abstraction/domSnapshot.ts), not
 * a live re-render -- see StateNode.html for why that distinction matters
 * for transient states.
 */
function previewScript(states: StateNode[], previewStylesheet: string | undefined): string {
  const previews: Record<string, { key: string; html: string; transient: boolean }> = {};
  for (const s of [...states].sort((a, b) => a.key.localeCompare(b.key))) {
    if (s.html === undefined) continue;
    previews[s.id] = { key: s.key, html: s.html, transient: s.transient === true };
  }
  const css = PREVIEW_BASE_CSS + (previewStylesheet ?? "");

  return `
const PREVIEWS = ${jsonForScript(previews)};
const PREVIEW_CSS = ${jsonForScript(css)};
const pane = document.getElementById("preview-pane");
const title = pane.querySelector(".preview-title");
const note = pane.querySelector(".preview-note");
const frame = pane.querySelector("iframe");
const closeBtn = pane.querySelector(".preview-close");
const triggers = new Map();
let current = null;

function srcdocFor(id) {
  const p = PREVIEWS[id];
  return "<!doctype html><meta charset=\\"utf-8\\"><style>" + PREVIEW_CSS + "</style>" + p.html;
}

function markTriggers() {
  for (const [id, els] of triggers) {
    for (const el of els) el.setAttribute("aria-expanded", id === current ? "true" : "false");
  }
}

function show(id) {
  const p = PREVIEWS[id];
  if (!p) return;
  current = id;
  title.textContent = p.key;
  note.textContent = p.transient ? "transient \\u2014 snapshot taken mid-flight" : "";
  frame.srcdoc = srcdocFor(id);
  pane.setAttribute("data-open", "");
  pane.setAttribute("aria-hidden", "false");
  document.body.classList.add("preview-open");
  markTriggers();
}

function hide() {
  current = null;
  pane.removeAttribute("data-open");
  pane.setAttribute("aria-hidden", "true");
  document.body.classList.remove("preview-open");
  // Dropping the srcdoc stops any timer/animation the previewed markup
  // might be running once the pane is closed.
  frame.removeAttribute("srcdoc");
  markTriggers();
}

function toggle(id) {
  if (current === id) hide();
  else show(id);
}

function bind(el, id) {
  const els = triggers.get(id) ?? [];
  els.push(el);
  triggers.set(id, els);
  el.addEventListener("click", (e) => {
    e.preventDefault();
    toggle(id);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(id);
    }
  });
}

closeBtn.addEventListener("click", hide);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && current !== null) hide();
});

for (const el of document.querySelectorAll("code.previewable")) {
  bind(el, el.getAttribute("data-preview"));
}

/**
 * Mermaid rewrites node ids (e.g. "state-n_s0-3"), so diagram nodes are
 * matched by looking for the generated id as a whole segment rather than by
 * exact equality -- "n_s0" must not match "n_s01".
 */
function bindDiagram() {
  const nodes = document.querySelectorAll(".mermaid g[id]");
  for (const [id, p] of Object.entries(PREVIEWS)) {
    const mid = "n_" + id.replace(/[^a-zA-Z0-9_]/g, "_");
    for (const node of nodes) {
      const parts = node.id.split(/[^a-zA-Z0-9_]+/);
      if (parts.indexOf(mid) !== -1) {
        node.setAttribute("data-previewable", "");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "button");
        node.setAttribute("aria-expanded", "false");
        bind(node, id);
        break;
      }
    }
  }
}
`;
}

const PREVIEW_CARD_HTML = `<aside id="preview-pane" aria-hidden="true" aria-label="state preview"><div class="preview-head"><span class="preview-title"></span><span class="preview-note"></span><button type="button" class="preview-close" aria-label="close preview">&times;</button></div><iframe sandbox="" title="rendered output for this state"></iframe></aside>`;

export interface RenderHtmlOptions {
  /** Wall-clock elapsed time to show in the budget section (kept out of the JSON artefact, but fine to show here). */
  elapsedMs?: number;
  /**
   * M6 Part 1: collapse maximal transient async chains (see
   * ./collapse.ts) into single labelled edges in the *diagram* only.
   * Default true. The state table always lists every state (collapsed
   * intermediates included, flagged in a "diagram" column), and the JSON
   * artefact (src/report/json.ts) is entirely unaffected by this flag --
   * this is presentation-layer only.
   */
  collapseTransientChains?: boolean;
  /**
   * CSS to inline into every state preview's iframe. Exploration runs under
   * jsdom, which never loads the application's stylesheet, so captured
   * markup is structurally accurate but unstyled: class names survive, the
   * rules behind them do not. Pass the component's compiled CSS here (plain
   * CSS or a built Tailwind file) to get styled previews. Runtime-injected
   * CSS-in-JS cannot be recovered this way.
   */
  previewStylesheet?: string;
}

function coreSections(result: ExplorationResult, opts: RenderHtmlOptions): string {
  const doCollapse = opts.collapseTransientChains ?? true;
  const collapsed = doCollapse ? collapseTransientChains(result.graph) : undefined;
  const diagramGraph = collapsed ? { states: collapsed.states, edges: collapsed.edges } : result.graph;
  const { source, large } = buildMermaidSource(diagramGraph);
  const incomplete = result.budget.exhausted;
  const stateCount = result.graph.states.length;
  const edgeCount = result.graph.edges.length;
  const collapsedCount = collapsed?.collapsedStateIds.size ?? 0;

  return `
    ${incomplete ? `<div class="incomplete-banner">INCOMPLETE RUN &mdash; budget was exhausted before exploration finished (${result.unexploredFrontier.length} frontier item(s) unexplored). This graph does not necessarily cover every reachable state.</div>` : ""}
    <h1>${esc(result.component)}</h1>
    <p class="subtitle">${stateCount} states, ${edgeCount} edges${collapsedCount > 0 ? ` (diagram: ${stateCount - collapsedCount} nodes shown, ${collapsedCount} transient state(s) collapsed into labelled edges)` : ""}</p>

    <section id="diagram">
      <h2>State diagram</h2>
      <div class="legend">
        <span><span class="swatch sw-default"></span>default-props state</span>
        <span><span class="swatch sw-generated"></span>generated-props state</span>
        <span><span class="swatch sw-transient"></span>transient (in-flight/async) state, dashed border</span>
        <span>edge label <code>auto:timer</code> / <code>auto:microtask</code> = automatic transition, no user action</span>
        <span>edge label prefixed <code>[gen]</code> = this transition was only observed under a generated-props assignment</span>
        <span>edge label prefixed <code>[unstable]</code> = settle() did not reach quiescence</span>
        <span>edge label prefixed <code>[non-det]</code> = same action from same state observed landing on different destinations</span>
        <span>edge label prefixed <code>[collapsed]</code>, with "(via ...)" = a whole transient async chain (user action &rarr; one or more transient intermediates &rarr; settled state) drawn as one edge; see the state table for the collapsed intermediates</span>
      </div>
      ${
        doCollapse
          ? `<p class="empty-note">Transient async chains are collapsed in this diagram (default). Collapsed intermediates are still listed in the state table below, marked "collapsed". ${
              collapsed && collapsed.branchNotes.length > 0
                ? `${collapsed.branchNotes.length} chain(s) could not be fully collapsed because a transient state along the way had more than one outgoing edge (branching); those are left expanded -- see below.`
                : ""
            }</p>`
          : `<p class="empty-note">Transient async chains are shown expanded (collapsing disabled for this report).</p>`
      }
      ${
        collapsed && collapsed.branchNotes.length > 0
          ? `<div class="large-graph-warning"><strong>Chains left expanded due to branching:</strong><ul>${collapsed.branchNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
          : ""
      }
      ${large ? `<div class="large-graph-warning">This graph has ${diagramGraph.states.length} diagram nodes, above the ${MERMAID_NODE_THRESHOLD}-node threshold for comfortable reading. It is still rendered in full below, but expect to need to zoom/scroll and to lean on the state table instead of the diagram for anything beyond a rough shape check.</div>` : ""}
      <div class="mermaid-container"><pre class="mermaid">${esc(source)}</pre></div>
    </section>

    <section id="states">
      <h2>State table</h2>
      <p class="empty-note">Every state is listed here, including transient states collapsed out of the diagram above (see the "diagram" column). Click a state key &mdash; or a node in the diagram &mdash; to open the markup that state actually rendered in a side pane. Escape closes it.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>key</th><th>provenance</th><th>transient</th><th>diagram</th><th>fields</th><th>witness</th></tr></thead>
          <tbody>${stateTableRows(result.graph.states, collapsed?.collapsedStateIds ?? new Set())}</tbody>
        </table>
      </div>
    </section>

    ${findingsHtml(result)}
    ${budgetHtml(result, opts.elapsedMs ?? result.budget.elapsedMs)}
  `;
}

/** Renders a single-assignment ExplorationResult as a self-contained HTML report. */
export function renderExplorationHtml(result: ExplorationResult, opts: RenderHtmlOptions = {}): string {
  const mermaidSrc = loadMermaidSource();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>react-fuzzer report: ${esc(result.component)}</title>
<style>${CSS}</style>
</head>
<body>
${coreSections(result, opts)}
<footer>Generated by react-fuzzer. Schema: single-assignment.</footer>
${PREVIEW_CARD_HTML}
<script>${mermaidSrc}</script>
<script>${previewScript(result.graph.states, opts.previewStylesheet)}
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
mermaid.run().then(bindDiagram);
</script>
</body>
</html>`;
}

/** Renders a merged MultiAssignmentResult as a self-contained HTML report, with the additional prop-analysis section. */
export function renderMultiAssignmentHtml(multi: MultiAssignmentResult, opts: RenderHtmlOptions = {}): string {
  const mermaidSrc = loadMermaidSource();
  const result = multi.merged;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>react-fuzzer report: ${esc(result.component)}</title>
<style>${CSS}</style>
</head>
<body>
${coreSections(result, opts)}
${propAnalysisHtml(multi)}
<footer>Generated by react-fuzzer. Schema: multi-assignment (${multi.runs.length} prop assignments).</footer>
${PREVIEW_CARD_HTML}
<script>${mermaidSrc}</script>
<script>${previewScript(result.graph.states, opts.previewStylesheet)}
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
mermaid.run().then(bindDiagram);
</script>
</body>
</html>`;
}
