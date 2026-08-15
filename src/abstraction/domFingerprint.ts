/**
 * M2.5 Deliverable B: a normalised fingerprint of rendered DOM, used to
 * detect hooks that vary but never affect what is rendered (see
 * ./adaptive.ts's DOM-correlation pruner).
 *
 * Normalisation keeps element tag names, trimmed text content, and a fixed
 * set of semantically relevant attributes (disabled, value, checked, role,
 * and all aria-* attributes), and drops everything else — inline styles,
 * class names, data-* attributes, React-internal markers — because those
 * are either volatile in ways unrelated to component state or not
 * meaningful to a user/assistive-technology observer, which is the
 * "observable through the UI" bar this fingerprint is meant to approximate.
 */

const SEMANTIC_ATTRS = new Set(["disabled", "value", "checked", "role"]);

function isSemanticAttr(name: string): boolean {
  return SEMANTIC_ATTRS.has(name) || name.startsWith("aria-");
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
