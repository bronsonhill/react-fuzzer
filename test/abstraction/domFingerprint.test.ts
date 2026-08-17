import { describe, expect, it } from "vitest";
import { computeDomFingerprint } from "../../src/abstraction/domFingerprint.js";

/**
 * Regression cover for the property-vs-attribute bug the MUI benchmarks
 * exposed: React sets `checked`/`value` as DOM properties on a controlled
 * input and leaves the attributes at their initial values, so an
 * attribute-only fingerprint could not tell a ticked checkbox from an
 * unticked one — and the DOM-correlation pruner then deleted the hook
 * driving it. See benchmarks/mui-notification-settings.
 */
describe("computeDomFingerprint", () => {
  function root(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  it("distinguishes a checkbox ticked via the property alone", () => {
    const before = root('<input type="checkbox">');
    const after = root('<input type="checkbox">');
    (after.querySelector("input") as HTMLInputElement).checked = true;

    expect(after.querySelector("input")!.getAttribute("checked")).toBeNull();
    expect(computeDomFingerprint(before)).not.toBe(computeDomFingerprint(after));
  });

  it("distinguishes a text input whose value was set as a property", () => {
    const before = root('<input type="text" value="a">');
    const after = root('<input type="text" value="a">');
    (after.querySelector("input") as HTMLInputElement).value = "b";

    expect(computeDomFingerprint(before)).not.toBe(computeDomFingerprint(after));
  });

  it("still ignores class names, inline styles and data attributes", () => {
    const plain = root("<p>hello</p>");
    const dressed = root('<p class="MuiTypography-root" style="color: red" data-testid="x">hello</p>');

    expect(computeDomFingerprint(plain)).toBe(computeDomFingerprint(dressed));
  });
});
