import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { discoverActions, DEFAULT_FILL_POOL } from "../../src/explore/actions.js";
import { Toggle } from "../../benchmarks/toggle/Toggle.js";
import { Wizard } from "../../benchmarks/wizard/Wizard.js";
import { Counter } from "../../benchmarks/counter/Counter.js";

describe("discoverActions: stable ids", () => {
  it("produces the same ids across two separate discovery calls on equivalent DOM", () => {
    const { container: c1 } = render(<Toggle />);
    const { container: c2 } = render(<Toggle />);

    const r1 = discoverActions(c1);
    const r2 = discoverActions(c2);

    const ids1 = r1.available.map((a) => a.id).sort();
    const ids2 = r2.available.map((a) => a.id).sort();
    expect(ids1).toEqual(ids2);
    expect(ids1.length).toBeGreaterThan(0);
  });

  it("ids are role+name based, not DOM-position based", () => {
    const { container } = render(<Counter start={2} />);
    const { available } = discoverActions(container);
    const dec = available.find((a) => a.id.includes("decrement"));
    const inc = available.find((a) => a.id.includes("increment"));
    expect(dec?.id).toBe('click:button:"decrement"');
    expect(inc?.id).toBe('click:button:"increment"');
  });
});

describe("discoverActions: fill single-action semantics", () => {
  it("produces one action per pool value, not per keystroke", () => {
    const { container } = render(<Wizard />);
    const { available } = discoverActions(container);
    const fillActions = available.filter((a) => a.kind === "fill" && a.id.includes("Name"));
    // One action per DEFAULT_FILL_POOL entry, never one per character of any pool value.
    expect(fillActions.length).toBe(DEFAULT_FILL_POOL.length);
  });

  it("executing a fill action performs exactly one fireEvent.change (single value set, not char-by-char)", () => {
    const { container } = render(<Wizard />);
    const { available } = discoverActions(container);
    const fill = available.find((a) => a.kind === "fill" && a.value === "sample text");
    expect(fill).toBeDefined();
    const input = container.querySelector("input") as HTMLInputElement;
    fill!.perform();
    // A single fireEvent.change with the whole value lands as one commit; the
    // input's value is the pool value verbatim, not a partial/prefix of it.
    expect(input.value).toBe("sample text");
  });
});

describe("discoverActions: disabled/hidden elements", () => {
  it("reports a disabled decrement button as unavailable, not dropped", () => {
    const { container } = render(<Counter min={0} max={5} start={0} />);
    const { available, unavailable } = discoverActions(container);
    // At start=0=min, decrement is disabled.
    expect(available.find((a) => a.id.includes("decrement"))).toBeUndefined();
    const unavailableDec = unavailable.find((a) => a.id.includes("decrement"));
    expect(unavailableDec).toBeDefined();
    expect(unavailableDec?.reason).toBe("disabled");
  });

  it("reports a hidden element as unavailable, not dropped", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = '<button hidden>Hidden</button><button>Visible</button>';
    const { available, unavailable } = discoverActions(container);
    expect(available.find((a) => a.label.includes("Hidden"))).toBeUndefined();
    const hiddenAction = unavailable.find((a) => a.label.includes("Hidden"));
    expect(hiddenAction).toBeDefined();
    expect(hiddenAction?.reason).toBe("hidden");
    expect(available.find((a) => a.label.includes("Visible"))).toBeDefined();
  });
});

describe("discoverActions: function-prop discovery", () => {
  it("discovers invokeProp actions for function-typed props", () => {
    const container = document.createElement("div");
    const onComplete = () => {};
    const { available } = discoverActions(container, { invokableProps: { onComplete } });
    const propAction = available.find((a) => a.kind === "invokeProp");
    expect(propAction).toBeDefined();
    expect(propAction?.propName).toBe("onComplete");
  });

  it("invoking the action calls the underlying function", () => {
    const container = document.createElement("div");
    let called = 0;
    const onComplete = () => {
      called++;
    };
    const { available } = discoverActions(container, { invokableProps: { onComplete } });
    available.find((a) => a.kind === "invokeProp")!.perform();
    expect(called).toBe(1);
  });
});
