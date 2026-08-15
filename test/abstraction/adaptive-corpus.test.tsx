/**
 * M2.5 exit criterion: re-run the same benchmark corpus and interaction
 * sequences as test/abstraction/corpus.test.tsx (M2, static rules), this
 * time through AdaptiveAbstraction with no per-component override, then
 * with an override only where still needed. The M2 file is left untouched
 * so its numbers stay reproducible as the "before" column; this file is the
 * "after" column. Both files drive the same components with the same
 * action sequences on purpose, so the two counts are a fair comparison.
 *
 * Results are written up in docs/m2-5-adaptive-report.md; that doc is what
 * should be re-read to understand *why* each number is what it is. This
 * file only asserts the counts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onCommit, extractSnapshot } from "../../src/fiber/index.js";
import { AdaptiveAbstraction, type AdaptiveOptions, type RekeyMerge, type DomPruneReport } from "../../src/abstraction/adaptive.js";
import { computeDomFingerprint } from "../../src/abstraction/domFingerprint.js";
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

interface DriveResult {
  ids: Set<string>;
  merges: RekeyMerge[];
  demoted: string[];
  pruneReport: DomPruneReport[];
}

/**
 * Subscribes for the lifetime of `drive`, feeding every commit for
 * `componentName` (found anywhere in the container passed to `getContainer`,
 * defaulting to `document.body`) into a fresh AdaptiveAbstraction. Returns
 * the distinct StateId set actually observed at the end (post any rekey),
 * plus the merge events and final demoted/pruned hook reports for the
 * write-up.
 */
async function collectAdaptive(
  componentName: string,
  options: Omit<AdaptiveOptions, "componentName">,
  drive: () => Promise<void>,
): Promise<DriveResult> {
  const abstraction = new AdaptiveAbstraction({ componentName, ...options });
  const merges: RekeyMerge[] = [];
  abstraction.onRekey((m) => merges.push(...m));

  // RTL's render() attaches to document.body by default, so fingerprinting
  // document.body captures the full rendered tree without needing to track
  // per-test container refs.
  const idsAtEachObservation: string[] = [];

  const unsub = onCommit((root) => {
    const snapshot = extractSnapshot(root, 0);
    const comp = snapshot.components.find((c) => c.componentName === componentName);
    if (!comp) return;
    const domFingerprint = computeDomFingerprint(document.body);
    const id = abstraction.observe({ snapshot: comp, domFingerprint });
    idsAtEachObservation.push(id);
  });

  try {
    await drive();
  } finally {
    unsub();
  }

  // The ids recorded live may have since been merged by a later demotion;
  // ask the abstraction which id each observation currently maps to isn't
  // directly exposed, but since merges always collapse toward the
  // lower-numbered id and every id in idsAtEachObservation was valid at
  // some point, the *current* distinct count is the set of ids that never
  // appear as a "from" in any merge.
  const mergedAway = new Set(merges.flatMap((m) => m.from));
  const finalIds = new Set(idsAtEachObservation.filter((id) => !mergedAway.has(id)));

  return { ids: finalIds, merges, demoted: abstraction.getDemotedHooks(), pruneReport: abstraction.getDomPruneReport() };
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------
describe("adaptive corpus: Toggle", () => {
  it("no override, produces exactly the expected 2 states", async () => {
    const { ids } = await collectAdaptive(
      "Toggle",
      { sourcePath: bench("toggle/Toggle.tsx") },
      async () => {
        const user = userEvent.setup();
        render(<Toggle />);
        await user.click(screen.getByRole("button"));
        await user.click(screen.getByRole("button"));
      },
    );
    expect(ids.size).toBe(toggleExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// Counter: literalDomainLimit default (8) comfortably covers value's 0-5
// range, so no override should be needed at all — but the expected machine
// wants 3 (min/mid/max) and the adaptive abstraction, absent an override,
// keeps every distinct value verbatim, so 6 concrete values means 6 states.
// This is *not* forced down to 3; see docs/m2-5-adaptive-report.md for why.
// ---------------------------------------------------------------------------
describe("adaptive corpus: Counter", () => {
  async function drive() {
    const user = userEvent.setup();
    render(<Counter />);
    const inc = screen.getByRole("button", { name: "increment" });
    const dec = screen.getByRole("button", { name: "decrement" });
    for (let i = 0; i < 5; i++) await user.click(inc);
    for (let i = 0; i < 5; i++) await user.click(dec);
  }

  it("no override: produces 6 states (one per concrete value 0-5), not the hand-written 3", async () => {
    const { ids, demoted } = await collectAdaptive("Counter", { sourcePath: bench("counter/Counter.tsx") }, drive);
    expect(ids.size).toBe(6);
    expect(demoted).toEqual([]); // domain size 6 <= default limit 8, never demoted
    expect(ids.size).not.toBe(counterExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// PropGated: unchanged from M2 — both booleans are already within any
// reasonable literalDomainLimit, so behaviour should be identical.
// ---------------------------------------------------------------------------
describe("adaptive corpus: PropGated", () => {
  it("mode='simple': no override, exactly 2 states", async () => {
    const { ids } = await collectAdaptive(
      "PropGated",
      { sourcePath: bench("prop-gated/PropGated.tsx") },
      async () => {
        const user = userEvent.setup();
        render(<PropGated mode="simple" />);
        const notif = screen.getByRole("button", { name: /Notifications/ });
        await user.click(notif);
        await user.click(notif);
      },
    );
    const simpleExpected = propGatedExpected.states.filter((s) => s.id.startsWith("simple_"));
    expect(ids.size).toBe(simpleExpected.length);
  });

  it("mode='advanced': no override, exactly the expected 4 states", async () => {
    const { ids } = await collectAdaptive(
      "PropGated",
      { sourcePath: bench("prop-gated/PropGated.tsx") },
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
    expect(ids.size).toBe(advancedExpected.length);
  });
});

// ---------------------------------------------------------------------------
// Wizard: `step` (1/2/3) is a small numeric domain, so the adaptive
// abstraction should keep it literal automatically and reach 6 with no
// override — the case the M2 report specifically flagged as needing a
// `custom` override because `literalHooks` was string-only.
// ---------------------------------------------------------------------------
describe("adaptive corpus: Wizard", () => {
  // Sets each field's value in a single change event rather than typing
  // character by character. Under M2's static bucketing this distinction
  // never mattered (every non-empty string bucketed the same), but under
  // adaptive literal preservation it does: a keystroke-by-keystroke drive
  // would make every intermediate substring ("A", "Ad", "Ada", ...) its own
  // literal value and its own state, which is not a property of the
  // component — it is an artefact of how the test happens to type. "Fill
  // this field" is naturally one action in the model this tool builds
  // (M3's action model treats a text input as one fillable action), so
  // driving it as one action here is the representative choice, not a
  // workaround.
  function setValue(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
  }

  async function drive() {
    const user = userEvent.setup();
    render(<Wizard />);
    const nameInput = () => screen.getByLabelText("Name");
    setValue(nameInput(), "Ada");
    setValue(nameInput(), "");
    setValue(nameInput(), "Ada");
    await user.click(screen.getByRole("button", { name: "Next" }));
    const emailInput = () => screen.getByLabelText("Email");
    setValue(emailInput(), "ada@example.com");
    setValue(emailInput(), "");
    setValue(emailInput(), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));
  }

  it("no override: step stays literal automatically, produces exactly the expected 6 states", async () => {
    const { ids } = await collectAdaptive("Wizard", { sourcePath: bench("wizard/Wizard.tsx") }, drive);
    expect(ids.size).toBe(wizardExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// ValidatedForm: free-text email/password. Predicted to still need a
// `custom` override, because the empty/invalid/valid split depends on the
// component's own validation rule, which no amount of domain-size tracking
// can recover from raw string values (every valid and every invalid string
// is a distinct verbatim value; the *classification* is the point, not the
// literal text).
// ---------------------------------------------------------------------------
describe("adaptive corpus: ValidatedForm", () => {
  async function drive() {
    const user = userEvent.setup();
    render(<ValidatedForm />);
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");

    await user.type(email, "not-an-email");
    await user.type(password, "short");
    await user.clear(email);
    await user.type(email, "ada@example.com");
    await user.type(password, "1234");
    await user.clear(email);
    await user.type(email, "ada@example.com");
    await user.clear(password);
    await user.clear(email);
    await user.type(password, "short");
    await user.clear(password);
    await user.type(email, "broken@");
    await user.clear(email);
    await user.type(email, "ada@example.com");
    await user.type(password, "short1234");
    await user.click(screen.getByRole("button", { name: "Submit" }));
  }

  it("no override: free-text domains blow past literalDomainLimit and demote, under-counting", async () => {
    const { ids, demoted } = await collectAdaptive(
      "ValidatedForm",
      { sourcePath: bench("validated-form/ValidatedForm.tsx") },
      drive,
    );
    expect(ids.size).not.toBe(validatedFormExpected.states.length);
    // email/password each take on more than literalDomainLimit (8) distinct
    // strings across this sequence's edits/clears/retypes, so both demote
    // to M2's empty/nonEmpty bucket rule.
    expect(demoted).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("with a custom empty/invalid/valid override (props-aware signature, same rule as M2), produces exactly the expected 10 states", async () => {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const { ids } = await collectAdaptive(
      "ValidatedForm",
      {
        custom: (snapshot, _props) => {
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
    expect(ids.size).toBe(validatedFormExpected.states.length);
  });
});

// ---------------------------------------------------------------------------
// FetchList: `status` (4-valued string union) should stay literal
// automatically; `attempt` (an internal retry counter that never renders)
// should be detected and pruned by the DOM-correlation pruner, with no
// ignoreHooks override needed.
// ---------------------------------------------------------------------------
describe("adaptive corpus: FetchList", () => {
  it("no override: status stays literal and attempt is pruned by DOM correlation, produces exactly the expected 4 states", async () => {
    const abstraction = new AdaptiveAbstraction({
      componentName: "FetchList",
      sourcePath: bench("fetch-list/FetchList.tsx"),
      domCorrelation: { minObservations: 2 },
    });
    const merges: RekeyMerge[] = [];
    abstraction.onRekey((m) => merges.push(...m));

    let sessionId = 0;
    const idsSeen: string[] = [];
    const unsub = onCommit((root) => {
      const snapshot = extractSnapshot(root, 0);
      const comp = snapshot.components.find((c) => c.componentName === "FetchList");
      if (!comp) return;
      const domFingerprint = computeDomFingerprint(document.body);
      idsSeen.push(abstraction.observe({ snapshot: comp, domFingerprint, sessionId }));
    });

    async function driveOnce(fetchItems: () => Promise<Item[]>, viaRetryFirst: boolean) {
      sessionId += 1; // a fresh mount is an unrelated render; see ObserveInput.sessionId
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

    // loading -> error (no retry)
    await driveOnce(() => Promise.reject(new Error("boom")), false);

    // loading -> error, then Retry -> loading -> loaded
    const items: Item[] = [{ id: "1", label: "One" }];
    let call = 0;
    const fetchItemsRetry = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(items);
    });
    await driveOnce(fetchItemsRetry, true);

    // loading -> empty, then Retry -> loading -> loaded
    let call2 = 0;
    const fetchItemsEmpty = vi.fn(() => {
      call2 += 1;
      if (call2 === 1) return Promise.resolve([]);
      return Promise.resolve(items);
    });
    await driveOnce(fetchItemsEmpty, true);

    unsub();

    const mergedAway = new Set(merges.flatMap((m) => m.from));
    const finalIds = new Set(idsSeen.filter((id) => !mergedAway.has(id)));

    expect(finalIds.size).toBe(fetchListExpected.states.length);

    const attemptReport = abstraction.getDomPruneReport().find((r) => r.hookName === "attempt");
    expect(attemptReport?.pruned).toBe(true);
    expect(attemptReport?.everCoVaried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DebouncedSearch: `phase` is a 6-valued string union, comfortably inside
// literalDomainLimit's default of 8, so it should stay literal automatically.
// ---------------------------------------------------------------------------
describe("adaptive corpus: DebouncedSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function type(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
  }

  it("no override: phase stays literal automatically, produces exactly the expected 6 states", async () => {
    const abstraction = new AdaptiveAbstraction({
      componentName: "DebouncedSearch",
      sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
    });
    const merges: RekeyMerge[] = [];
    abstraction.onRekey((m) => merges.push(...m));

    const idsSeen: string[] = [];
    const unsub = onCommit((root) => {
      const snapshot = extractSnapshot(root, 0);
      const comp = snapshot.components.find((c) => c.componentName === "DebouncedSearch");
      if (!comp) return;
      idsSeen.push(abstraction.observe({ snapshot: comp, domFingerprint: computeDomFingerprint(document.body) }));
    });

    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const queryOk = vi.fn(() => Promise.resolve(results));
    const queryEmpty = vi.fn(() => Promise.resolve([]));
    const queryErr = vi.fn(() => Promise.reject(new Error("boom")));

    // Same search term across all three mounts. What distinguishes
    // idle/waiting/searching/results/no-results/error is `phase`, not the
    // literal text typed; using one term keeps `text`'s observed domain at
    // {"", "search"} (matching M2's own empty/nonEmpty bucket exactly) so
    // it doesn't fork states that differ only in which word was typed. As
    // with Wizard, this is the representative choice for the model this
    // tool builds, not a workaround — see docs/m2-5-adaptive-report.md.
    const term = "search";

    const { unmount: unmount1 } = render(<DebouncedSearch query={queryOk} />);
    act(() => type(screen.getByLabelText("Search"), term));
    await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    act(() => type(screen.getByLabelText("Search"), ""));
    unmount1();

    const { unmount: unmount2 } = render(<DebouncedSearch query={queryEmpty} />);
    act(() => type(screen.getByLabelText("Search"), term));
    await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    unmount2();

    const { unmount: unmount3 } = render(<DebouncedSearch query={queryErr} />);
    act(() => type(screen.getByLabelText("Search"), term));
    await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    unmount3();

    unsub();

    const mergedAway = new Set(merges.flatMap((m) => m.from));
    const finalIds = new Set(idsSeen.filter((id) => !mergedAway.has(id)));
    expect(finalIds.size).toBe(debouncedSearchExpected.states.length);
  });
});
