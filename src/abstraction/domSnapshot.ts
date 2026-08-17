/**
 * Captures the markup rendered under a container, for the HTML report's
 * state previews (docs/state-preview-proposal.md, Option 1).
 *
 * This is a sibling of ./domFingerprint.ts and runs at the same moment --
 * inside settle()'s onCommit, while the DOM still reflects the commit being
 * observed. The fingerprint answers "is this the same state?"; this answers
 * "what did it look like?", so it keeps far more: class names, inline
 * styles, data-* attributes, everything a stylesheet might key off.
 *
 * Two things it does *not* do the way `innerHTML` would:
 *
 *  - React-internal attributes (`__reactProps$...`, `data-reactroot`) are
 *    dropped. They carry a per-render random suffix, which would make the
 *    JSON artefact differ between two otherwise identical runs and break
 *    the determinism guarantee test/report/json.test.tsx asserts.
 *  - Live form state is reflected back into attributes. `value` and
 *    `checked` on a controlled input are DOM *properties*; `innerHTML`
 *    serialises attributes, so a filled-in field would otherwise preview as
 *    empty -- which for a fuzzer whose main action kind is `fill` would make
 *    the preview lie about exactly the thing under test.
 *
 * Attributes are emitted in sorted order for the same determinism reason.
 */

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function isReactInternalAttr(name: string): boolean {
  return name.startsWith("__react") || name === "data-reactroot";
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Attributes that should mirror the element's current property value rather
 * than whatever was last written to the attribute. See this module's doc
 * comment.
 */
function liveAttrs(el: Element): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const input = el as HTMLInputElement;
    out.push(["value", input.value ?? ""]);
    if (input.type === "checkbox" || input.type === "radio") {
      if (input.checked) out.push(["checked", ""]);
    }
  }
  if (tag === "option" && (el as HTMLOptionElement).selected) {
    out.push(["selected", ""]);
  }
  if (tag === "select") {
    // <select> has no value attribute to serialise; the selected <option>
    // (handled above) carries it.
  }
  return out;
}

function serialiseElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const attrs = new Map<string, string>();
  for (const attr of Array.from(el.attributes)) {
    if (isReactInternalAttr(attr.name)) continue;
    attrs.set(attr.name, attr.value);
  }
  for (const [name, value] of liveAttrs(el)) attrs.set(name, value);

  const attrStr = [...attrs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`))
    .join("");

  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrStr}/>`;

  const children = Array.from(el.childNodes).map(serialiseNode).join("");
  return `<${tag}${attrStr}>${children}</${tag}>`;
}

function serialiseNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
  if (node.nodeType === Node.ELEMENT_NODE) return serialiseElement(node as Element);
  // Comments and everything else: dropped. React uses comment nodes as
  // Suspense/fragment markers, which are implementation detail, not output.
  return "";
}

/**
 * Serialises everything rendered *inside* `root` (the container div itself
 * is the test harness's, not the component's, so it is not included) into a
 * deterministic HTML string suitable for embedding in an `<iframe srcdoc>`.
 */
export function captureMarkup(root: Element): string {
  return Array.from(root.childNodes).map(serialiseNode).join("");
}
