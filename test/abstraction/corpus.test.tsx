/**
 * M2 exit criterion: for every benchmark component, drive it through an
 * exhaustive (or near-exhaustive) manual interaction sequence, collect the
 * set of distinct StateKey.key values the abstraction produces, and compare
 * against the hand-written `expected.states` count.
 *
 * Each component gets two passes: "default rules" (abstractState with no
 * overrides beyond, at most, sourcePath for hook naming) and "with
 * overrides" (whatever literalHooks/ignoreHooks/custom the component
 * actually needs). Both counts are asserted so a regression in either the
 * default rules or the override is caught. Every mismatch and its cause is
 * written up in docs/m2-abstraction-report.md.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onCommit, extractSnapshot, type CommitSnapshot } from "../../src/fiber/index.js";
import { abstractState, type AbstractionOptions } from "../../src/abstraction/index.js";
import { settle } from "../../src/settle.js";

import { Toggle } from "../../benchmarks/toggle/Toggle.js";
import { Counter } from "../../benchmarks/counter/Counter.js";
import { PropGated } from "../../benchmarks/prop-gated/PropGated.js";
import { Wizard } from "../../benchmarks/wizard/Wizard.js";
import { ValidatedForm } from "../../benchmarks/validated-form/ValidatedForm.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

import { expected as toggleExpected } from "../../benchmarks/toggle/Toggle.expected.js";
import { expected as counterExpected } from "../../benchmarks/counter/Counter.expected.js";
import { expected as propGatedExpected } from "../../benchmarks/prop-gated/PropGated.expected.js";
import { expected as wizardExpected } from "../../benchmarks/wizard/Wizard.expected.js";
import { expected as validatedFormExpected } from "../../benchmarks/validated-form/ValidatedForm.expected.js";
import { expected as fetchListExpected } from "../../benchmarks/fetch-list/FetchList.expected.js";
import { expected as debouncedSearchExpected } from "../../benchmarks/debounced-search/DebouncedSearch.expected.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function bench(relPath: string): string {
  return path.join(repoRoot, "benchmarks", relPath);
}

/**
 * Subscribes for the lifetime of the callback, recording the StateKey.key
 * produced by `abstractState` for `componentName` after every commit.
 * Returns the distinct key set.
 */
async function collectStateKeys(
  componentName: string,
  options: AbstractionOptions,
  drive: () => Promise<void>,
): Promise<{ keys: Set<string>; warnings: Set<string> }> {
  const keys = new Set<string>();
  const warnings = new Set<string>();
  let commitIndex = -1;

  const unsub = onCommit((root) => {
    commitIndex++;
    const snapshot = extractSnapshot(root, commitIndex);
    const comp = snapshot.components.find((c) => c.componentName === componentName);
    if (!comp) return;
    const result = abstractState(comp, options) as ReturnType<typeof abstractState> & { warnings?: string[] };
    keys.add(result.key);
    result.warnings?.forEach((w) => warnings.add(w));
  });

  try {
    await drive();
  } finally {
    unsub();
  }

  return { keys, warnings };
}

// ---------------------------------------------------------------------------
// Toggle: trivial, default rules should be exact.
// ---------------------------------------------------------------------------
describe("corpus: Toggle", () => {
  it("default rules produce exactly the expected 2 states", async () => {
    const { keys } = await collectStateKeys(
      "Toggle",
      { componentName: "Toggle", sourcePath: bench("toggle/Toggle.tsx") },
      async () => {
        const user = userEvent.setup();
        render(<Toggle />);
        await user.click(screen.getByRole("button"));
        await user.click(screen.getByRole("button"));
      },
    );
    expect(keys.size).toBe(toggleExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// Counter: sign-and-zero number bucket cannot see "at max" (value never goes
// negative under default props, so it's zero/positive only). Documents the
// mismatch, then shows the override (a `custom` that knows min/max) recovers 3.
// ---------------------------------------------------------------------------
describe("corpus: Counter", () => {
  async function drive() {
    const user = userEvent.setup();
    render(<Counter />);
    const inc = screen.getByRole("button", { name: "increment" });
    const dec = screen.getByRole("button", { name: "decrement" });
    for (let i = 0; i < 5; i++) await user.click(inc); // 0 -> 5, through every value
    for (let i = 0; i < 5; i++) await user.click(dec); // 5 -> 0
  }

  it("default sign-and-zero bucket under-counts: only zero/positive, not min/mid/max", async () => {
    const { keys } = await collectStateKeys(
      "Counter",
      { componentName: "Counter", sourcePath: bench("counter/Counter.tsx") },
      drive,
    );
    // Documented defect: value is always >= 0 under default props (min=0),
    // so the sign bucket only ever produces "zero" or "positive" — it cannot
    // distinguish "at max" (5) from any other positive value (1-4).
    expect(keys.size).toBe(2);
    expect(keys.size).not.toBe(counterExpected.states.length);
  });

  it("with a custom min/mid/max override, produces exactly the expected 3 states", async () => {
    const { keys } = await collectStateKeys(
      "Counter",
      {
        componentName: "Counter",
        custom: (snapshot) => {
          const value = snapshot.hooks.find((h) => h.kind === "state")!.value as number;
          const bucket = value <= 0 ? "min" : value >= 5 ? "max" : "mid";
          return { key: `value=${bucket}`, fields: { value: bucket } };
        },
      },
      drive,
    );
    expect(keys.size).toBe(counterExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// PropGated: default rules (booleans kept verbatim) should already be exact
// in both modes, and — the actual point of this benchmark — expertModeOn
// must not manufacture phantom states in 'simple' mode since no action ever
// changes it there.
// ---------------------------------------------------------------------------
describe("corpus: PropGated", () => {
  it("mode='simple': default rules give exactly 2 states, not 4", async () => {
    const { keys } = await collectStateKeys(
      "PropGated",
      { componentName: "PropGated", sourcePath: bench("prop-gated/PropGated.tsx") },
      async () => {
        const user = userEvent.setup();
        render(<PropGated mode="simple" />);
        const notif = screen.getByRole("button", { name: /Notifications/ });
        await user.click(notif);
        await user.click(notif);
      },
    );
    const simpleExpected = propGatedExpected.states.filter((s) => s.id.startsWith("simple_"));
    expect(keys.size).toBe(simpleExpected.length);
    expect(keys.size).toBe(2); // empirically confirms expertModeOn (constant false) does not multiply the count
  });

  it("mode='advanced': default rules give exactly the expected 4 states", async () => {
    const { keys } = await collectStateKeys(
      "PropGated",
      { componentName: "PropGated", sourcePath: bench("prop-gated/PropGated.tsx") },
      async () => {
        const user = userEvent.setup();
        render(<PropGated mode="advanced" />);
        const notif = screen.getByRole("button", { name: /Notifications/ });
        const expert = screen.getByRole("button", { name: /Expert mode/ });
        await user.click(notif);
        await user.click(expert);
        await user.click(notif);
        await user.click(expert);
      },
    );
    const advancedExpected = propGatedExpected.states.filter((s) => s.id.startsWith("advanced_"));
    expect(keys.size).toBe(advancedExpected.length);
  });
});

// ---------------------------------------------------------------------------
// Wizard: `step` is a small numeric union (1/2/3), not a string, so the
// existing literalHooks escape hatch (string-only) doesn't cover it. The
// sign-and-zero number bucket collapses step to a constant "positive",
// which collides step1-filled with step2-empty (both name=nonEmpty,
// email=empty) and step2-filled with step3 (both name=nonEmpty,
// email=nonEmpty). A `custom` override that keeps step verbatim recovers
// the expected 6.
// ---------------------------------------------------------------------------
describe("corpus: Wizard", () => {
  async function drive() {
    const user = userEvent.setup();
    render(<Wizard />);
    const nameInput = () => screen.getByLabelText("Name");
    await user.type(nameInput(), "Ada"); // step1-empty -> step1-filled
    await user.clear(nameInput()); // -> step1-empty
    await user.type(nameInput(), "Ada"); // -> step1-filled
    await user.click(screen.getByRole("button", { name: "Next" })); // -> step2-empty
    const emailInput = () => screen.getByLabelText("Email");
    await user.type(emailInput(), "ada@example.com"); // -> step2-filled
    await user.clear(emailInput()); // -> step2-empty
    await user.type(emailInput(), "ada@example.com"); // -> step2-filled
    await user.click(screen.getByRole("button", { name: "Next" })); // -> step3
    await user.click(screen.getByRole("button", { name: "Back" })); // -> step2-filled
    await user.click(screen.getByRole("button", { name: "Next" })); // -> step3
    await user.click(screen.getByRole("button", { name: "Finish" })); // -> done
  }

  it("default rules under-count: step collapses to a constant, colliding two pairs of states", async () => {
    const { keys } = await collectStateKeys(
      "Wizard",
      { componentName: "Wizard", sourcePath: bench("wizard/Wizard.tsx") },
      drive,
    );
    expect(keys.size).toBe(4); // step1-empty, {step1-filled === step2-empty}, {step2-filled === step3}, done
    expect(keys.size).not.toBe(wizardExpected.states.length);
  });

  it("with a custom override keeping step verbatim, produces exactly the expected 6 states", async () => {
    const { keys } = await collectStateKeys(
      "Wizard",
      {
        componentName: "Wizard",
        custom: (snapshot) => {
          const stateHooks = snapshot.hooks.filter((h) => h.kind === "state");
          const [step, name, email, done] = stateHooks.map((h) => h.value) as [number, string, string, boolean];
          if (done) return { key: "done", fields: { done: true } };
          const fields = {
            step,
            name: name.length === 0 ? "empty" : "nonEmpty",
            email: email.length === 0 ? "empty" : "nonEmpty",
          };
          return { key: `step=${fields.step}|name=${fields.name}|email=${fields.email}`, fields };
        },
      },
      drive,
    );
    expect(keys.size).toBe(wizardExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// ValidatedForm: email/password need a {empty, invalid, valid} classification
// that neither the default rule (empty/nonEmpty) nor literalHooks (verbatim,
// unbounded domain) can express, since the valid/invalid split depends on
// business logic (a regex, a length check) rather than a fixed literal set.
// Requires a full `custom` override.
// ---------------------------------------------------------------------------
describe("corpus: ValidatedForm", () => {
  async function drive() {
    const user = userEvent.setup();
    render(<ValidatedForm />);
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    // email-empty_pw-empty (initial)
    await user.type(email, "not-an-email"); // -> email-invalid_pw-empty
    await user.type(password, "short"); // -> email-invalid_pw-invalid
    await user.clear(email);
    await user.type(email, "ada@example.com"); // -> email-valid_pw-invalid
    await user.type(password, "1234"); // "short1234" -> email-valid_pw-valid
    await user.clear(email); // -> email-empty_pw-valid
    await user.type(email, "ada@example.com"); // -> email-valid_pw-valid
    await user.clear(password); // -> email-valid_pw-empty
    await user.clear(email); // -> email-empty_pw-empty
    await user.type(password, "short"); // -> email-empty_pw-invalid
    await user.clear(password);
    await user.type(email, "broken@"); // invalid email, empty pw -> email-invalid_pw-empty (again)
    await user.clear(email);
    await user.type(email, "ada@example.com");
    await user.type(password, "short1234"); // -> email-valid_pw-valid
    await user.click(screen.getByRole("button", { name: "Submit" })); // -> submitted
  }

  it("default rules under-count: 3-way email/password classification is not empty/nonEmpty", async () => {
    const { keys } = await collectStateKeys(
      "ValidatedForm",
      { componentName: "ValidatedForm", sourcePath: bench("validated-form/ValidatedForm.tsx") },
      drive,
    );
    // empty/nonEmpty x empty/nonEmpty (4) + submitted (1) = 5, not the
    // expected 10 (invalid and valid both bucket to "nonEmpty").
    expect(keys.size).toBe(5);
    expect(keys.size).not.toBe(validatedFormExpected.states.length);
  });

  it("with a custom empty/invalid/valid override, produces exactly the expected 10 states", async () => {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const { keys } = await collectStateKeys(
      "ValidatedForm",
      {
        componentName: "ValidatedForm",
        custom: (snapshot) => {
          const stateHooks = snapshot.hooks.filter((h) => h.kind === "state");
          const [email, password, submitted] = stateHooks.map((h) => h.value) as [string, string, boolean];
          if (submitted) return { key: "submitted", fields: { submitted: true } };
          const classify = (v: string, valid: (s: string) => boolean) =>
            v.length === 0 ? "empty" : valid(v) ? "valid" : "invalid";
          const fields = {
            email: classify(email, (v) => EMAIL_RE.test(v)),
            password: classify(password, (v) => v.length >= 8),
          };
          return { key: `email=${fields.email}|password=${fields.password}`, fields };
        },
      },
      drive,
    );
    expect(keys.size).toBe(validatedFormExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// FetchList: `status` is a string-literal-union ('loading'/'error'/'empty'/
// 'loaded'), which the default nonEmpty-string rule collapses. `attempt` is
// an internal retry counter that must be *ignored* — its sign bucket
// (zero/positive) would otherwise split "loading" into two distinct states
// depending on whether it's the first load or a post-Retry reload, which the
// expected machine explicitly treats as one state (see its notes).
// ---------------------------------------------------------------------------
describe("corpus: FetchList", () => {
  it("default rules under-count: status collapses, and unignored attempt would over-count", async () => {
    const items: Item[] = [{ id: "1", label: "One" }];
    let call = 0;
    const fetchItems = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(items);
    });

    const { keys } = await collectStateKeys(
      "FetchList",
      { componentName: "FetchList", sourcePath: bench("fetch-list/FetchList.tsx") },
      async () => {
        const user = userEvent.setup();
        render(<FetchList fetchItems={fetchItems} />);
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument()); // -> error
        await user.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(screen.getByRole("list")).toBeInTheDocument()); // -> loaded
      },
    );
    // loading (attempt=0, items=empty), error (items=empty) collapse with
    // loading; loading-after-retry (attempt=1/positive, items=empty) is
    // distinct from the first because attempt is not yet ignored here;
    // loaded (items=one) is distinct. So more than 2 keys, but not the
    // correct 4 either, and for the wrong reason (attempt splitting a state
    // that should be single, not status distinguishing states that should
    // be separate).
    expect(keys.size).toBeGreaterThan(2);
    expect(keys.size).not.toBe(fetchListExpected.states.length);
  });

  it("with status literal-preserved and attempt ignored, produces exactly the expected 4 states", async () => {
    async function driveOnce(fetchItems: () => Promise<Item[]>, viaRetryFirst: boolean) {
      const user = userEvent.setup();
      const { unmount } = render(<FetchList fetchItems={fetchItems} />);
      await settle({ useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 });
      if (viaRetryFirst) {
        const retry = screen.queryByRole("button", { name: "Retry" });
        if (retry) {
          await user.click(retry);
          await settle({ useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 });
        }
      }
      unmount();
    }

    const options: AbstractionOptions = {
      componentName: "FetchList",
      sourcePath: bench("fetch-list/FetchList.tsx"),
      literalHooks: ["status"],
      ignoreHooks: ["attempt"],
    };

    const keys = new Set<string>();
    const record = () => {
      let commitIndex = -1;
      return onCommit((root) => {
        commitIndex++;
        const snapshot = extractSnapshot(root, commitIndex);
        const comp = snapshot.components.find((c) => c.componentName === "FetchList");
        if (!comp) return;
        keys.add(abstractState(comp, options).key);
      });
    };

    // loading -> error, then Retry -> loading -> loaded
    let unsub = record();
    await driveOnce(() => Promise.reject(new Error("boom")), false);
    unsub();

    // loading -> empty, then Retry -> loading -> loaded
    unsub = record();
    const items: Item[] = [{ id: "1", label: "One" }];
    let call = 0;
    const fetchItems = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve([]);
      return Promise.resolve(items);
    });
    await driveOnce(fetchItems, true);
    unsub();

    expect(keys.size).toBe(fetchListExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// DebouncedSearch: `phase` is a string-literal union
// ('idle'/'waiting'/'searching'/'results'/'no-results'/'error'). Default
// rules collapse all non-empty phases together; literalHooks recovers all 6.
// ---------------------------------------------------------------------------
describe("corpus: DebouncedSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function type(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
  }

  async function drive() {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const queryOk = vi.fn(() => Promise.resolve(results));
    const queryEmpty = vi.fn(() => Promise.resolve([]));
    const queryErr = vi.fn(() => Promise.reject(new Error("boom")));

    // idle -> waiting -> searching -> results -> idle
    const { unmount: unmount1 } = render(<DebouncedSearch query={queryOk} />);
    act(() => type(screen.getByLabelText("Search"), "a"));
    await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    act(() => type(screen.getByLabelText("Search"), ""));
    unmount1();

    // idle -> waiting -> searching -> no-results
    const { unmount: unmount2 } = render(<DebouncedSearch query={queryEmpty} />);
    act(() => type(screen.getByLabelText("Search"), "b"));
    await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    unmount2();

    // idle -> waiting -> searching -> error
    const { unmount: unmount3 } = render(<DebouncedSearch query={queryErr} />);
    act(() => type(screen.getByLabelText("Search"), "c"));
    await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    unmount3();
  }

  it("default rules under-count: phase collapses, only idle vs non-idle is visible", async () => {
    const { keys } = await collectStateKeys(
      "DebouncedSearch",
      { componentName: "DebouncedSearch", sourcePath: bench("debounced-search/DebouncedSearch.tsx") },
      drive,
    );
    expect(keys.size).toBeLessThan(debouncedSearchExpected.states.length);
  });

  it("with phase literal-preserved, produces exactly the expected 6 states", async () => {
    const { keys } = await collectStateKeys(
      "DebouncedSearch",
      {
        componentName: "DebouncedSearch",
        sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
        literalHooks: ["phase"],
      },
      drive,
    );
    expect(keys.size).toBe(debouncedSearchExpected.states.length);
  });
});
