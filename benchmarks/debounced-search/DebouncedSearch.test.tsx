import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DebouncedSearch, type SearchResult } from "./DebouncedSearch.js";

// userEvent's internal delay/timer handling does not play well with fake
// timers, so these tests drive the input with fireEvent directly and control
// the clock explicitly with vi.advanceTimersByTime. This is exactly the kind
// of timing control the real explorer will need for this component.

describe("DebouncedSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function type(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
  }

  it("drives idle -> waiting -> searching -> results -> idle", async () => {
    const results: SearchResult[] = [{ id: "1", label: "Result A" }];
    const query = vi.fn(() => Promise.resolve(results));

    render(<DebouncedSearch query={query} />);
    const input = screen.getByLabelText("Search");

    // state: idle
    expect(screen.getByText("Type to search")).toBeInTheDocument();

    // transition: type -> waiting
    act(() => type(input, "a"));
    expect(screen.getByText("...")).toBeInTheDocument();
    expect(query).not.toHaveBeenCalled();

    // transition: advance clock -> searching -> settle -> results
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledWith("a");
    expect(screen.getByText("Result A")).toBeInTheDocument();

    // transition: clear -> idle
    act(() => type(input, ""));
    expect(screen.getByText("Type to search")).toBeInTheDocument();
  });

  it("drives waiting -> waiting (reset) -> searching -> no-results", async () => {
    const query = vi.fn(() => Promise.resolve([]));

    render(<DebouncedSearch query={query} />);
    const input = screen.getByLabelText("Search");

    // transition: idle -> waiting
    act(() => type(input, "a"));
    expect(screen.getByText("...")).toBeInTheDocument();

    // partial advance, not enough to fire
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(query).not.toHaveBeenCalled();

    // transition: waiting -> waiting (timer reset by new keystroke)
    act(() => type(input, "ab"));
    expect(screen.getByText("...")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(query).not.toHaveBeenCalled();

    // transition: waiting -> searching -> no-results
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(query).toHaveBeenCalledWith("ab");
    expect(query).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("drives searching -> error", async () => {
    const query = vi.fn(() => Promise.reject(new Error("boom")));

    render(<DebouncedSearch query={query} />);
    const input = screen.getByLabelText("Search");

    act(() => type(input, "x"));
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Search failed");

    // transition: error -> idle
    act(() => type(input, ""));
    expect(screen.getByText("Type to search")).toBeInTheDocument();
  });

  it("clears from waiting straight back to idle", () => {
    const query = vi.fn(() => Promise.resolve([]));

    render(<DebouncedSearch query={query} />);
    const input = screen.getByLabelText("Search");

    act(() => type(input, "a"));
    expect(screen.getByText("...")).toBeInTheDocument();

    // transition: waiting -> idle (cleared before debounce elapses)
    act(() => type(input, ""));
    expect(screen.getByText("Type to search")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(query).not.toHaveBeenCalled();
  });
});
