/**
 * Deliverable D.2/D.3: prove settle() correctly handles the async benchmark
 * cases and is stable across repeated runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { settle } from "../../src/settle.js";
import { onCommit, extractSnapshot } from "../../src/fiber/index.js";
import { findComponentSnapshot } from "./helpers.js";
import { FetchList, type Item } from "../../benchmarks/fetch-list/FetchList.js";
import { DebouncedSearch, type SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

describe("settle: FetchList (promise-based, real timers)", () => {
  it("settles into 'loaded' after the fetch promise resolves", async () => {
    const items: Item[] = [{ id: "1", label: "One" }];
    const fetchItems = () => Promise.resolve(items);

    render(<FetchList fetchItems={fetchItems} />);

    const result = await settle({ useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 });

    expect(result.settled).toBe(true);
    expect(result.reason).toBe("stable");
    const comp = findComponentSnapshot(result.snapshot, "FetchList");
    expect(comp.hooks[0]).toMatchObject({ kind: "state", value: "loaded" });
  });

  it("settles into 'error' when the fetch promise rejects", async () => {
    const fetchItems = () => Promise.reject(new Error("boom"));

    render(<FetchList fetchItems={fetchItems} />);

    const result = await settle({ useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 });

    expect(result.settled).toBe(true);
    const comp = findComponentSnapshot(result.snapshot, "FetchList");
    expect(comp.hooks[0]).toMatchObject({ value: "error" });
  });
});

describe("settle: DebouncedSearch (debounce + async, fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits 'waiting' immediately (before the debounce fires), distinct from 'searching'", () => {
    // Direct commit inspection, not settle(): the point here is that
    // 'waiting' and 'searching' are two separate, individually observable
    // commits, not that settle() should stop at the first one.
    const query = vi.fn(() => Promise.resolve([]));
    const seenPhases: unknown[] = [];
    const unsub = onCommit((root) => {
      const snap = extractSnapshot(root, 0);
      const comp = snap.components.find((c) => c.componentName === "DebouncedSearch");
      if (comp) seenPhases.push(comp.hooks[1]?.value);
    });

    render(<DebouncedSearch query={query} />);
    act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));

    expect(seenPhases).toContain("idle");
    expect(seenPhases).toContain("waiting");
    expect(seenPhases).not.toContain("searching");
    expect(query).not.toHaveBeenCalled();
    unsub();
  });

  it("settles at 'results' after the debounce and query resolve, having passed through 'searching' as a distinct intermediate commit", async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const seenPhases: unknown[] = [];
    const query = vi.fn(() => Promise.resolve(results));

    const unsub = onCommit((root) => {
      const snap = extractSnapshot(root, 0);
      const comp = snap.components.find((c) => c.componentName === "DebouncedSearch");
      if (comp) seenPhases.push(comp.hooks[1]?.value);
    });

    render(<DebouncedSearch query={query} />);
    act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));

    const result = await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 });
    unsub();

    expect(result.settled).toBe(true);
    const comp = findComponentSnapshot(result.snapshot, "DebouncedSearch");
    expect(comp.hooks[1]).toMatchObject({ value: "results" });
    expect(query).toHaveBeenCalledWith("a");
    // 'waiting' and 'searching' both occurred as distinct commits en route.
    expect(seenPhases).toContain("waiting");
    expect(seenPhases).toContain("searching");
    expect(seenPhases).toContain("results");
  });

  it("marks the transition unstable (settled: false) when the iteration budget runs out before the 300ms debounce timer elapses", async () => {
    // 3 iterations * 50ms = 150ms of virtual time, short of the 300ms
    // debounce. The debounce's setTimeout is still pending the whole time
    // (vi.getTimerCount() > 0), so settle() must not declare stability just
    // because no commit happened yet in this narrow window.
    const query = vi.fn(() => Promise.resolve([]));
    render(<DebouncedSearch query={query} />);

    act(() => fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } }));

    const result = await settle({ useFakeTimers: true, timerStepMs: 50, maxIterations: 3, maxTimeBudgetMs: 5000 });

    expect(result.settled).toBe(false);
    expect(result.reason).toBe("iteration-limit");
    expect(query).not.toHaveBeenCalled();
  });
});
