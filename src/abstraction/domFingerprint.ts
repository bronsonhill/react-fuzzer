/**
 * M2.5 Deliverable B: a normalised fingerprint of rendered DOM, used to
 * detect hooks that vary but never affect what is rendered (see
 * ./adaptive.ts's DOM-correlation pruner).
 *
 * Normalisation keeps element tag names, trimmed text content, and a fixed
 * set of semantically relevant attributes (disabled, value, checked, role,
 * and all aria-* attributes) — with value/checked read from the live DOM
 * property on form controls, since that is where a controlled input's
 * current state actually lives — and drops everything else — inline styles,
 * class names, data-* attributes, React-internal markers — because those
 * are either volatile in ways unrelated to component state or not
 * meaningful to a user/assistive-technology observer, which is the
 * "observable through the UI" bar this fingerprint is meant to approximate.
 */

const SEMANTIC_ATTRS = new Set(["disabled", "value", "checked", "role"]);

function isSemanticAttr(name: string): boolean {
  return SEMANTIC_ATTRS.has(name) || name.startsWith("aria-");
}

function liveControlState(el: Element): Record<string, string> {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") return { checked: String(input.checked) };
    return { value: input.value };
  }
  if (tag === "textarea") return { value: (el as HTMLTextAreaElement).value };
  if (tag === "select") return { value: (el as HTMLSelectElement).value };
  return {};
}

function walk(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent?.trim();
    return text ? `#(${text})` : "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (isSemanticAttr(attr.name)) attrs.push(`${attr.name}=${attr.value}`);
  }
  // Form controls carry their current state in DOM *properties*, not
  // attributes: React (and anything else driving a controlled input) sets
  // `input.checked` / `input.value`, while the `checked` and `value`
  // attributes keep holding the initial values. Reading the attributes
  // alone makes a ticked checkbox indistinguishable from an unticked one,
  // which in turn makes the DOM-correlation pruner delete the hook behind
  // it as "state that never affects what is rendered". Overriding with the
  // live property values fixes that; it showed up first against MUI's
  // Checkbox/Switch, whose ticked/unticked difference is otherwise carried
  // only by class names and an SVG path.
  const live = liveControlState(el);
  for (const [name, value] of Object.entries(live)) {
    const idx = attrs.findIndex((a) => a.startsWith(`${name}=`));
    const entry = `${name}=${value}`;
    if (idx === -1) attrs.push(entry);
    else attrs[idx] = entry;
  }
  attrs.sort();

  const children = Array.from(el.childNodes)
    .map(walk)
    .filter((s) => s.length > 0)
    .join(",");

  return `${el.tagName.toLowerCase()}[${attrs.join(";")}]{${children}}`;
}

/**
 * Computes a stable string fingerprint of the structure, text, and
 * semantically relevant attributes rendered under `root`. Two renders that
 * are indistinguishable to a user (same structure, same visible text, same
 * disabled/aria state) produce the same fingerprint even if unrelated
 * internals differ.
 */
export function computeDomFingerprint(root: Element): string {
  return walk(root);
}
