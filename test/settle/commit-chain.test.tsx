/**
 * M3.5, Problem 1: settle() must report every commit it observes, not just
 * the final one, so a caller can turn "loading"/"waiting"-shaped
 * intermediate commits into their own states instead of only ever seeing
 * where the component eventually settles. See docs/m3-5-refinement-report.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { settle } from "../../src/settle.js";
import { findComponentSnapshot } from "./helpers.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

describe("settle: commit chain (real timers, FetchList)", () => {
  it("commits array's first entry is the synchronous 'loading' render (driver: initial), last entry is the settled 'error'", async () => {
    const fetchItems = () => Promise.reject(new Error("boom"));
    render(<FetchList fetchItems={fetchItems} />);

    const result = await settle({ useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 });

    expect(result.settled).toBe(true);
    expect(result.commits.length).toBeGreaterThanOrEqual(2);
    expect(result.commits[0]!.driver).toBe("initial");
    const firstComp = findComponentSnapshot(result.commits[0]!.snapshot, "FetchList");
    expect(firstComp.hooks[0]).toMatchObject({ value: "loading" });

    const last = result.commits[result.commits.length - 1]!;
    const lastComp = findComponentSnapshot(last.snapshot, "FetchList");
    expect(lastComp.hooks[0]).toMatchObject({ value: "error" });
    // snapshot equals the last chain entry's snapshot, per the doc comment.
    expect(result.snapshot).toBe(last.snapshot);
  });
});

describe("settle: commit chain (fake timers, DebouncedSearch)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports 'waiting' (initial), 'searching' (timer-driven), 'results' (microtask-driven) as three distinct chain entries", async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const query = vi.fn(() => Promise.resolve(results));
    render(<DebouncedSearch query={query} />);
    act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));

    const result = await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });

    expect(result.settled).toBe(true);
    const phases = result.commits.map((c) => ({
      driver: c.driver,
      phase: findComponentSnapshot(c.snapshot, "DebouncedSearch").hooks[1]?.value,
    }));
    expect(phases).toEqual([
      { driver: "initial", phase: "waiting" },
      { driver: "timer", phase: "searching" },
      { driver: "microtask", phase: "results" },
    ]);
  });

  it("timerAdvance: next-timer reaches the same final snapshot as fixed stepping, without following the same intermediate iteration count", async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const query = vi.fn(() => Promise.resolve(results));
    render(<DebouncedSearch query={query} />);
    act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));

    const result = await settle({
      useFakeTimers: true,
      timerAdvance: "next-timer",
      timerStepMs: 50,
      maxIterations: 20,
      maxTimeBudgetMs: 2000,
    });

    expect(result.settled).toBe(true);
    const lastComp = findComponentSnapshot(result.snapshot, "DebouncedSearch");
    expect(lastComp.hooks[1]).toMatchObject({ value: "results" });
    // Still observes every intermediate commit -- next-timer changes how far
    // the clock jumps per iteration, not which commits happen.
    const phases = result.commits.map((c) => findComponentSnapshot(c.snapshot, "DebouncedSearch").hooks[1]?.value);
    expect(phases).toEqual(["waiting", "searching", "results"]);
  });
});
