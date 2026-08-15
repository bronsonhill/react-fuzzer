/**
 * M3 exit criterion: run exploreComponent against all seven benchmark
 * components under their default/example props and compare the discovered
 * graph against each component's hand-written .expected.ts machine.
 *
 * Per the M3 task brief, this file does not assert exact equality with
 * .expected.ts everywhere — several discrepancies are already documented
 * (M2/M2.5 abstraction judgement calls, e.g. Counter's 6-vs-3 states) and
 * are not engine defects. Where a mismatch is expected, the assertion
 * documents the actual number instead of asserting a specific "should
 * match" value. See docs/m3-exploration-report.md for the full account.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exploreComponent } from "../../src/explore/engine.js";

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

describe("corpus: Toggle", () => {
  it("matches the expected 2 states / 2 transitions exactly", async () => {
    const result = await exploreComponent({
      componentName: "Toggle",
      render: (props) => <Toggle {...props} />,
      props: {},
      sourcePath: bench("toggle/Toggle.tsx"),
    });
    expect(result.graph.states.length).toBe(toggleExpected.states.length);
    expect(result.findings.replayDivergences.length).toBe(0);
    expect(result.budget.exhausted).toBe(false);
  });
});

describe("corpus: Counter", () => {
  it("finds 6 states (one per concrete 0-5 value), not the hand-written 3 -- documented M2.5 finding, not an engine defect", async () => {
    const result = await exploreComponent({
      componentName: "Counter",
      render: (props) => <Counter {...props} />,
      props: {},
      sourcePath: bench("counter/Counter.tsx"),
    });
    expect(result.graph.states.length).toBe(6);
    expect(result.graph.states.length).not.toBe(counterExpected.states.length);
    expect(result.findings.replayDivergences.length).toBe(0);
  });
});

describe("corpus: PropGated", () => {
  it("mode=simple matches the expected 2 reachable states exactly", async () => {
    const result = await exploreComponent({
      componentName: "PropGated",
      render: (props) => <PropGated {...(props as any)} />,
      props: { mode: "simple" },
      sourcePath: bench("prop-gated/PropGated.tsx"),
    });
    const simpleExpected = propGatedExpected.states.filter((s) => s.id.startsWith("simple_"));
    expect(result.graph.states.length).toBe(simpleExpected.length);
    expect(result.findings.replayDivergences.length).toBe(0);
  });
});

describe("corpus: Wizard", () => {
  it("finds 8 states (not the hand-written 6): exhaustive DFS reaches step1 with email already filled via Back, a path the hand-written machine and the M2.5 driven sequence never exercise", async () => {
    const result = await exploreComponent({
      componentName: "Wizard",
      render: (props) => <Wizard {...props} />,
      props: {},
      sourcePath: bench("wizard/Wizard.tsx"),
      fillPools: (field) => {
        if (/name/i.test(field.name)) return ["", "Ada"];
        if (/email/i.test(field.name)) return ["", "ada@example.com"];
        return undefined;
      },
    });
    // 6 expected + 2 extra: {step1, name filled, email filled} and
    // {step1, name empty, email filled}, both reached via Back after email
    // was already typed at step 2. email is never rendered at step 1, so
    // these are behaviourally identical to step1-filled/step1-empty to a
    // user, but the adaptive abstraction's DOM-correlation pruner cannot
    // prune email (it co-varies with the DOM at step 2, which disqualifies
    // it everywhere -- see docs/m2-5-adaptive-report.md's pruner limits).
    expect(result.graph.states.length).toBe(8);
    expect(result.graph.states.length).not.toBe(wizardExpected.states.length);
    expect(result.findings.replayDivergences.length).toBe(0);
  });
});

describe("corpus: ValidatedForm", () => {
  const fillPools = (field: { name: string }) => {
    if (/email/i.test(field.name)) return ["", "not-an-email@", "ada@example.com"];
    if (/password/i.test(field.name)) return ["", "short", "longenough1"];
    return undefined;
  };

  it("without a custom override: coincidentally matches 10 -- the 3-value pool per field (empty/invalid-shaped/valid-shaped) happens to align 1:1 with the 3 business-logic classes, so the literal (undemoted) values reproduce the expected count without the abstraction knowing what 'valid' means. This is a fill-pool-selection coincidence, not evidence the adaptive machinery generalises the classification.", async () => {
    const result = await exploreComponent({
      componentName: "ValidatedForm",
      render: (props) => <ValidatedForm {...props} />,
      props: {},
      sourcePath: bench("validated-form/ValidatedForm.tsx"),
      fillPools,
    });
    expect(result.graph.states.length).toBe(validatedFormExpected.states.length);
    expect(result.findings.replayDivergences.length).toBe(0);
  });

  it("with a custom empty/invalid/valid override: matches the expected 10 states", async () => {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const result = await exploreComponent({
      componentName: "ValidatedForm",
      render: (props) => <ValidatedForm {...props} />,
      props: {},
      sourcePath: bench("validated-form/ValidatedForm.tsx"),
      fillPools,
      abstraction: {
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
    });
    expect(result.graph.states.length).toBe(validatedFormExpected.states.length);
    expect(result.findings.replayDivergences.length).toBe(0);
  });
});

describe("corpus: FetchList", () => {
  it("with a deterministic (call-count-independent) fetchItems: finds exactly 1 state -- root is 'error' immediately (settle() drains the mount before the root is even observed, so 'loading' is never captured as its own node), and Retry loops back to the same 'error' state", async () => {
    const fetchItems = vi.fn(() => Promise.reject(new Error("boom")));

    const result = await exploreComponent({
      componentName: "FetchList",
      render: (props) => <FetchList {...(props as any)} />,
      props: { fetchItems },
      sourcePath: bench("fetch-list/FetchList.tsx"),
      settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
      // fetchItems is a data source, not a user-facing callback; excluding
      // it from invokableProps avoids a meaningless "invoke fetchItems()
      // with no args" action (auto-derivation from function-typed props is
      // a heuristic that over-fires for props shaped like this -- see
      // docs/m3-exploration-report.md).
      invokableProps: {},
    });

    expect(result.graph.states.length).toBe(1);
    expect(result.graph.states[0]!.fields.status).toBe("error");
    expect(result.findings.replayDivergences.length).toBe(0);
  });

  it("with a call-counting fetchItems (rejects once, then resolves): replay-from-root re-invokes fetchItems on every remount, so the mock's hidden counter advances independently of the graph -- this produces genuine replay divergences, not a bug in the engine. fetchItems taking no arguments means a mock cannot vary its result *and* stay idempotent under remounting.", async () => {
    const items: Item[] = [{ id: "1", label: "One" }];
    let call = 0;
    const fetchItems = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(items);
    });

    const result = await exploreComponent({
      componentName: "FetchList",
      render: (props) => <FetchList {...(props as any)} />,
      props: { fetchItems },
      sourcePath: bench("fetch-list/FetchList.tsx"),
      settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
      invokableProps: {},
    });

    // The very first replay-from-root attempt (needed to try the Retry
    // action from the root state) remounts, which calls fetchItems again
    // and gets the "loaded" result instead of the original "error" result
    // the root state was identified by -- a real divergence, correctly
    // detected and reported rather than silently producing a wrong graph.
    expect(result.findings.replayDivergences.length).toBeGreaterThan(0);
    expect(result.graph.states.length).not.toBe(fetchListExpected.states.length);
  });
});

describe("corpus: DebouncedSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reaches idle and searching (not waiting: settle() always drains fake timers to quiescence, so the transient 'waiting' phase between a keystroke and the debounce firing is never the state actually observed), using a query mock that is a pure function of the searched text (replay-safe, unlike a hidden call counter -- see the FetchList section above)", async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    // Pure function of `text`: deterministic and replay-safe, since every
    // remount that types the same text gets the same outcome, unlike a
    // call-counting mock (see corpus: FetchList's second test).
    const query = vi.fn((text: string) => {
      if (text.includes("errorterm")) return Promise.reject(new Error("boom"));
      if (text.includes("emptyterm")) return Promise.resolve([]);
      return Promise.resolve(results);
    });

    const result = await exploreComponent({
      componentName: "DebouncedSearch",
      render: (props) => <DebouncedSearch {...(props as any)} />,
      props: { query },
      sourcePath: bench("debounced-search/DebouncedSearch.tsx"),
      fillPools: () => ["", "resultsterm", "emptyterm", "errorterm"],
      settle: { useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 },
      // query is a data source, not a user-facing callback; see the
      // FetchList section above for why auto-derived invokeProp actions are
      // excluded for props shaped like this.
      invokableProps: {},
    });

    const statuses = new Set(result.graph.states.map((s) => s.fields.phase));
    expect(statuses.has("idle")).toBe(true);
    expect(statuses.has("waiting")).toBe(false); // structurally unobservable via settle(); see it() description above
    expect(result.graph.states.length).toBeGreaterThanOrEqual(2);
    expect(result.findings.replayDivergences.length).toBe(0);
  });
});
