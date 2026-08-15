/**
 * Deliverable D (exit criterion): settle detection must be stable across
 * 100 repeated runs, for the two async benchmark components. "Stable" means
 * every run produces an identical final CommitSnapshot (same hook kinds and
 * values) and settled: true with the same reason. If any run diverges, that
 * is the finding to report, not something to loosen the assertion around.
 */
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { settle } from "../../src/settle.js";
import { findComponentSnapshot } from "./helpers.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

const RUNS = 100;

describe("settle stability (100 runs)", () => {
  it(`FetchList settles to 'loaded' identically across ${RUNS} runs`, async () => {
    const items: Item[] = [{ id: "1", label: "One" }];
    const snapshots: unknown[] = [];
    const outcomes: { settled: boolean; reason: string | undefined }[] = [];

    const start = Date.now();
    for (let i = 0; i < RUNS; i++) {
      const fetchItems = () => Promise.resolve(items);
      render(<FetchList fetchItems={fetchItems} />);

      const result = await settle({ useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 });
      outcomes.push({ settled: result.settled, reason: result.reason });
      const comp = findComponentSnapshot(result.snapshot, "FetchList");
      snapshots.push(comp.hooks.map((h) => ({ kind: h.kind, value: h.value })));

      cleanup();
    }
    const elapsedMs = Date.now() - start;
    // eslint-disable-next-line no-console
    console.log(`FetchList stability: ${RUNS} runs in ${elapsedMs}ms (${(elapsedMs / RUNS).toFixed(2)}ms/run)`);

    expect(outcomes.every((o) => o.settled === true && o.reason === "stable")).toBe(true);
    const first = JSON.stringify(snapshots[0]);
    expect(snapshots.every((s) => JSON.stringify(s) === first)).toBe(true);
  }, 60_000);

  it(`DebouncedSearch settles to 'results' identically across ${RUNS} runs`, async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const snapshots: unknown[] = [];
    const outcomes: { settled: boolean; reason: string | undefined }[] = [];

    vi.useFakeTimers();
    const start = Date.now();
    try {
      for (let i = 0; i < RUNS; i++) {
        const query = () => Promise.resolve(results);
        render(<DebouncedSearch query={query} />);

        act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));

        const result = await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
        outcomes.push({ settled: result.settled, reason: result.reason });
        const comp = findComponentSnapshot(result.snapshot, "DebouncedSearch");
        snapshots.push(comp.hooks.map((h) => ({ kind: h.kind, value: h.value })));

        cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
    const elapsedMs = Date.now() - start;
    // eslint-disable-next-line no-console
    console.log(`DebouncedSearch stability: ${RUNS} runs in ${elapsedMs}ms (${(elapsedMs / RUNS).toFixed(2)}ms/run)`);

    expect(outcomes.every((o) => o.settled === true && o.reason === "stable")).toBe(true);
    const first = JSON.stringify(snapshots[0]);
    expect(snapshots.every((s) => JSON.stringify(s) === first)).toBe(true);
  }, 60_000);
});
