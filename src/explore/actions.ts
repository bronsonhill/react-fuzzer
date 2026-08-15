/**
 * M3: action discovery. Enumerates candidate actions from a rendered
 * container plus (optionally) the root component's function-typed props.
 *
 * Stable ids: `${kind}:${role}:"${name}"[:disambiguator]`, built from the
 * accessible role and name computed here, never from DOM position or fiber
 * internals. Two separate discovery calls against equivalent rendered output
 * (e.g. before/after a replay-from-root remount) produce the same ids for
 * the same elements, which is what makes witness replay possible: an
 * ActionRef recorded during one mount can be looked up by id in a freshly
 * discovered action list after a different mount of the same output.
 *
 * Fill-value pools and the explosion trade-off: a text field has an
 * unbounded input domain. Trying every possible string is not feasible, so
 * each fill produces one action per *pool* value rather than one action per
 * character (see docs/m2-5-adaptive-report.md — per-keystroke actions
 * inflate adaptive state counts and are not how this tool models "set a
 * field"). The default pool (empty, a plausible value, one likely-invalid
 * value) is small on purpose: bigger pools find more states but cost more
 * budget (each pool value is a full action, replayed on every backtrack).
 * Off-pool values may reach states this discovery pass cannot find; that is
 * a real coverage gap, not an oversight, and callers with domain knowledge
 * of a specific field should supply their own pool via `fillPools`.
 */
import { fireEvent } from "@testing-library/react";

export type FillPoolResolver = (field: { name: string; type: string; element: HTMLElement }) => string[] | undefined;

export interface DiscoverActionsOptions {
  /**
   * Per-field fill value pools. A plain map is matched by accessible name
   * (case-insensitive); a function receives the field and may inspect its
   * type/name to decide (e.g. detect "email" in the name and supply a
   * malformed-email value). Falls back to DEFAULT_FILL_POOL when neither
   * matches.
   */
  fillPools?: Record<string, string[]> | FillPoolResolver;
  /** Function-typed props on the root component, exposed as `invokeProp` actions. Not discoverable from the DOM alone, so the caller threads them through. */
  invokableProps?: Record<string, (...args: unknown[]) => unknown>;
}

export const DEFAULT_FILL_POOL = ["", "sample text", "not-an-email@"];

export type DiscoveredActionKind = "click" | "fill" | "toggle" | "select" | "invokeProp";

export interface DiscoveredAction {
  id: string;
  kind: DiscoveredActionKind;
  label: string;
  value?: string;
  optionValue?: string;
  propName?: string;
  /** Executes this action against the DOM (or invokes the prop). Not serialisable; only present on the live discovery result. */
  perform: () => void;
}

export interface UnavailableAction extends DiscoveredAction {
  reason: string;
}

export interface DiscoverActionsResult {
  available: DiscoveredAction[];
  unavailable: UnavailableAction[];
}

function computeAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();

  const id = el.getAttribute("id");
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const closestLabel = el.closest("label");
  if (closestLabel?.textContent) return closestLabel.textContent.trim();

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();

  if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") {
    if (el.textContent) return el.textContent.trim();
  }

  const nameAttr = el.getAttribute("name");
  if (nameAttr) return nameAttr;

  return el.textContent?.trim() ?? "";
}

function computeRole(el: HTMLElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit") return "button";
    return "textbox";
  }
  return tag;
}

function isDisabled(el: HTMLElement): boolean {
  if ("disabled" in el && (el as HTMLInputElement).disabled) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  return false;
}

function isHidden(el: HTMLElement): boolean {
  if (el.hidden) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  let node: HTMLElement | null = el;
  while (node) {
    if (node.style && node.style.display === "none") return true;
    node = node.parentElement;
  }
  return false;
}

function resolvePool(
  name: string,
  type: string,
  element: HTMLElement,
  opts: DiscoverActionsOptions["fillPools"],
): string[] {
  if (typeof opts === "function") {
    const result = opts({ name, type, element });
    if (result) return result;
  } else if (opts) {
    const match = Object.keys(opts).find((k) => k.toLowerCase() === name.toLowerCase());
    if (match) return opts[match]!;
  }
  return DEFAULT_FILL_POOL;
}

/**
 * Discovers candidate actions in `container`, an already-rendered subtree
 * (e.g. from RTL's `render()`). Disabled or hidden elements are still
 * discovered — their actions land in `unavailable` with a reason, rather
 * than being silently dropped, so a caller (engine.ts) can report on them.
 */
export function discoverActions(container: HTMLElement, opts: DiscoverActionsOptions = {}): DiscoverActionsResult {
  const available: DiscoveredAction[] = [];
  const unavailable: UnavailableAction[] = [];
  const idCounts = new Map<string, number>();

  function nextId(kind: string, role: string, name: string): string {
    const base = `${kind}:${role}:"${name}"`;
    const n = idCounts.get(base) ?? 0;
    idCounts.set(base, n + 1);
    return n === 0 ? base : `${base}:${n}`;
  }

  function pushAction(
    kind: DiscoveredActionKind,
    role: string,
    name: string,
    label: string,
    perform: () => void,
    el: HTMLElement,
    extra: Partial<DiscoveredAction> = {},
  ): void {
    const id = nextId(kind, role, name);
    const action: DiscoveredAction = { id, kind, label, perform, ...extra };
    if (isDisabled(el)) {
      unavailable.push({ ...action, reason: "disabled" });
      return;
    }
    if (isHidden(el)) {
      unavailable.push({ ...action, reason: "hidden" });
      return;
    }
    available.push(action);
  }

  const clickable = container.querySelectorAll<HTMLElement>(
    'button, a[href], [role="button"], input[type="button"], input[type="submit"]',
  );
  for (const el of Array.from(clickable)) {
    const role = computeRole(el);
    const name = computeAccessibleName(el);
    pushAction("click", role, name, `click ${role} "${name}"`, () => {
      fireEvent.click(el);
    }, el);
  }

  const checkable = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
  for (const el of Array.from(checkable)) {
    const role = computeRole(el);
    const name = computeAccessibleName(el);
    const kind: DiscoveredActionKind = el.type === "checkbox" ? "toggle" : "select";
    pushAction(kind, role, name, `${kind} ${role} "${name}"`, () => {
      fireEvent.click(el);
    }, el);
  }

  const textFields = container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'textarea, input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input[type="number"]',
  );
  for (const el of Array.from(textFields)) {
    const role = computeRole(el);
    const name = computeAccessibleName(el);
    const pool = resolvePool(name, el.getAttribute("type") ?? "text", el, opts.fillPools);
    for (const value of pool) {
      pushAction(
        "fill",
        role,
        name,
        `fill "${name}" with ${JSON.stringify(value)}`,
        () => {
          fireEvent.change(el, { target: { value } });
        },
        el,
        { value },
      );
    }
  }

  const selects = container.querySelectorAll<HTMLSelectElement>("select");
  for (const el of Array.from(selects)) {
    const role = computeRole(el);
    const name = computeAccessibleName(el);
    for (const option of Array.from(el.options)) {
      pushAction(
        "select",
        role,
        name,
        `select "${option.value}" in "${name}"`,
        () => {
          fireEvent.change(el, { target: { value: option.value } });
        },
        el,
        { optionValue: option.value },
      );
    }
  }

  if (opts.invokableProps) {
    for (const [propName, fn] of Object.entries(opts.invokableProps)) {
      const id = nextId("invokeProp", "prop", propName);
      available.push({
        id,
        kind: "invokeProp",
        label: `invoke prop "${propName}"`,
        propName,
        perform: () => {
          fn();
        },
      });
    }
  }

  return { available, unavailable };
}
