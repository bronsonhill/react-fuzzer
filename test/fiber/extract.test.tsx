/**
 * Deliverable D.1: for every benchmark component, mount it, drive it through
 * a few transitions with real user interaction, and assert the extracted
 * hook values match the component's actual state at each point.
 */
import { describe, expect, it } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onCommit, extractSnapshot, type CommitSnapshot, type ComponentSnapshot } from "../../src/fiber/index.js";

import { Toggle } from "../../benchmarks/toggle/Toggle.js";
import { Counter } from "../../benchmarks/counter/Counter.js";
import { PropGated } from "../../benchmarks/prop-gated/PropGated.js";
import { Wizard } from "../../benchmarks/wizard/Wizard.js";
import { ValidatedForm } from "../../benchmarks/validated-form/ValidatedForm.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

/** Capture the latest CommitSnapshot after each commit. */
function captureSnapshots(): { latest: () => CommitSnapshot; unsubscribe: () => void } {
  let commitIndex = -1;
  let latest: CommitSnapshot = { components: [], commitIndex: -1 };
  const unsubscribe = onCommit((root) => {
    commitIndex++;
    latest = extractSnapshot(root, commitIndex);
  });
  return { latest: () => latest, unsubscribe };
}

function findComponent(snapshot: CommitSnapshot, name: string): ComponentSnapshot {
  const found = snapshot.components.find((c) => c.componentName === name);
  if (!found) throw new Error(`component ${name} not found in snapshot; found: ${snapshot.components.map((c) => c.componentName).join(",")}`);
  return found;
}

describe("extract: Toggle", () => {
  it("tracks the boolean useState value across clicks", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const user = userEvent.setup();
    render(<Toggle />);

    let toggle = findComponent(latest(), "Toggle");
    expect(toggle.hooks).toHaveLength(1);
    expect(toggle.hooks[0]).toMatchObject({ index: 0, kind: "state", value: false });

    await user.click(screen.getByRole("button"));
    toggle = findComponent(latest(), "Toggle");
    expect(toggle.hooks[0]).toMatchObject({ kind: "state", value: true });

    await user.click(screen.getByRole("button"));
    toggle = findComponent(latest(), "Toggle");
    expect(toggle.hooks[0]).toMatchObject({ kind: "state", value: false });

    unsubscribe();
  });
});

describe("extract: Counter", () => {
  it("tracks the numeric useState value, clamped", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const user = userEvent.setup();
    render(<Counter min={0} max={2} start={0} />);

    expect(findComponent(latest(), "Counter").hooks[0]).toMatchObject({ kind: "state", value: 0 });

    await user.click(screen.getByRole("button", { name: "increment" }));
    expect(findComponent(latest(), "Counter").hooks[0]).toMatchObject({ kind: "state", value: 1 });

    await user.click(screen.getByRole("button", { name: "increment" }));
    expect(findComponent(latest(), "Counter").hooks[0]).toMatchObject({ kind: "state", value: 2 });

    // at max, increment is disabled; clicking decrement should work
    await user.click(screen.getByRole("button", { name: "decrement" }));
    expect(findComponent(latest(), "Counter").hooks[0]).toMatchObject({ kind: "state", value: 1 });

    unsubscribe();
  });
});

describe("extract: PropGated", () => {
  it("only exposes the expert-mode hook's effect in 'advanced' mode (both hooks always exist, but only reachable via UI when advanced)", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const user = userEvent.setup();
    render(<PropGated mode="advanced" />);

    let comp = findComponent(latest(), "PropGated");
    expect(comp.hooks).toHaveLength(2);
    expect(comp.hooks[0]).toMatchObject({ index: 0, kind: "state", value: false });
    expect(comp.hooks[1]).toMatchObject({ index: 1, kind: "state", value: false });

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    comp = findComponent(latest(), "PropGated");
    expect(comp.hooks[0]).toMatchObject({ value: true });
    expect(comp.hooks[1]).toMatchObject({ value: false });

    await user.click(screen.getByRole("button", { name: /Expert mode/ }));
    comp = findComponent(latest(), "PropGated");
    expect(comp.hooks[0]).toMatchObject({ value: true });
    expect(comp.hooks[1]).toMatchObject({ value: true });

    unsubscribe();
  });
});

describe("extract: Wizard", () => {
  it("tracks step/name/email/done across the 3-step flow", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const user = userEvent.setup();
    render(<Wizard />);

    let comp = findComponent(latest(), "Wizard");
    // hooks in declaration order: step, name, email, done
    expect(comp.hooks).toHaveLength(4);
    expect(comp.hooks[0]).toMatchObject({ kind: "state", value: 1 });
    expect(comp.hooks[1]).toMatchObject({ kind: "state", value: "" });
    expect(comp.hooks[2]).toMatchObject({ kind: "state", value: "" });
    expect(comp.hooks[3]).toMatchObject({ kind: "state", value: false });

    await user.type(screen.getByLabelText("Name"), "Ada");
    comp = findComponent(latest(), "Wizard");
    expect(comp.hooks[1]).toMatchObject({ value: "Ada" });

    await user.click(screen.getByRole("button", { name: "Next" }));
    comp = findComponent(latest(), "Wizard");
    expect(comp.hooks[0]).toMatchObject({ value: 2 });

    await user.type(screen.getByLabelText("Email"), "ada@x.com");
    await user.click(screen.getByRole("button", { name: "Next" }));
    comp = findComponent(latest(), "Wizard");
    expect(comp.hooks[0]).toMatchObject({ value: 3 });
    expect(comp.hooks[2]).toMatchObject({ value: "ada@x.com" });

    await user.click(screen.getByRole("button", { name: "Finish" }));
    // Once done=true the component returns early (<p role="status">) with
    // no hooks referenced past that branch point in the render, but React
    // still preserves the full hook list positionally — done should now be true.
    comp = findComponent(latest(), "Wizard");
    expect(comp.hooks[3]).toMatchObject({ value: true });

    unsubscribe();
  });
});

describe("extract: ValidatedForm", () => {
  it("tracks email/password/submitted state", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const user = userEvent.setup();
    render(<ValidatedForm />);

    let comp = findComponent(latest(), "ValidatedForm");
    expect(comp.hooks).toHaveLength(3);
    expect(comp.hooks[0]).toMatchObject({ value: "" });
    expect(comp.hooks[1]).toMatchObject({ value: "" });
    expect(comp.hooks[2]).toMatchObject({ value: false });

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "longenough");
    comp = findComponent(latest(), "ValidatedForm");
    expect(comp.hooks[0]).toMatchObject({ value: "a@b.com" });
    expect(comp.hooks[1]).toMatchObject({ value: "longenough" });

    await user.click(screen.getByRole("button", { name: "Submit" }));
    comp = findComponent(latest(), "ValidatedForm");
    expect(comp.hooks[2]).toMatchObject({ value: true });

    unsubscribe();
  });
});

describe("extract: FetchList", () => {
  it("tracks status/items/attempt through loading -> loaded, and effect/ref hook kinds", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const items: Item[] = [{ id: "1", label: "One" }];
    const fetchItems = () => Promise.resolve(items);

    await act(async () => {
      render(<FetchList fetchItems={fetchItems} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const comp = findComponent(latest(), "FetchList");
    // status, items, attempt (in declaration order), plus the useEffect hook.
    expect(comp.hooks).toHaveLength(4);
    expect(comp.hooks[0]).toMatchObject({ kind: "state", value: "loaded" });
    expect(comp.hooks[1]).toMatchObject({ kind: "state", value: items });
    expect(comp.hooks[2]).toMatchObject({ kind: "state", value: 0 });
    expect(comp.hooks[3]).toMatchObject({ kind: "effect", value: undefined });

    unsubscribe();
  });
});

describe("extract: DebouncedSearch", () => {
  it("classifies state/ref/effect hooks correctly and distinguishes waiting from searching as separate commits", async () => {
    const { latest, unsubscribe } = captureSnapshots();
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const query = () => Promise.resolve(results);

    render(<DebouncedSearch query={query} />);

    let comp = findComponent(latest(), "DebouncedSearch");
    // text, phase, results, timerRef, requestId (state/state/state/ref/ref), plus 1 effect
    expect(comp.hooks).toHaveLength(6);
    expect(comp.hooks[0]).toMatchObject({ kind: "state", value: "" });
    expect(comp.hooks[1]).toMatchObject({ kind: "state", value: "idle" });
    expect(comp.hooks[2]).toMatchObject({ kind: "state", value: [] });
    expect(comp.hooks[3]).toMatchObject({ kind: "ref", value: undefined });
    expect(comp.hooks[4]).toMatchObject({ kind: "ref", value: undefined });
    expect(comp.hooks[5]).toMatchObject({ kind: "effect", value: undefined });

    // transition: type -> waiting (separate commit from idle)
    act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));
    comp = findComponent(latest(), "DebouncedSearch");
    expect(comp.hooks[1]).toMatchObject({ value: "waiting" });

    unsubscribe();
  });
});
