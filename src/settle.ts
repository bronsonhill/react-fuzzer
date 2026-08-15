/**
 * Quiescence detection: after dispatching an action, drive commits to a
 * stable point and return the final snapshot.
 *
 * Decision on userEvent vs fireEvent under fake timers (see the M0 comment
 * in benchmarks/debounced-search/DebouncedSearch.test.tsx): userEvent's
 * internal delay handling hangs under `vi.useFakeTimers()` even when given
 * `advanceTimers`, because it awaits real setTimeout-based delays between
 * its own internal steps that fake timers never advance unless something
 * external pumps them concurrently, which a synchronous `act()` callback
 * cannot do. `settle()` therefore does not drive the initial action itself
 * — the caller performs the action (via `fireEvent`, or via `userEvent`
 * configured for real timers) — and `settle()` is only responsible for
 * draining whatever the action already triggered: pending timers and
 * microtasks. This sidesteps the conflict entirely: userEvent is fine to
 * use for actions when real timers are active, and fireEvent is what the
 * DebouncedSearch/FetchList benchmark tests already use under fake timers.
 */
import { act } from "@testing-library/react";
import { vi } from "vitest";
import { onCommit, extractSnapshot, getLastCommittedRoot, type CommitSnapshot } from "./fiber/index.js";

export interface SettleOptions {
  /**
   * Whether fake timers are active for this settle call. When true, each
   * settle iteration advances fake timers by `timerStepMs` to flush pending
   * setTimeout/setInterval callbacks; when false, iterations just drain
   * microtasks and wait a macrotask tick for real timers/promises to
   * resolve.
   */
  useFakeTimers: boolean;
  /** Milliseconds of virtual time to advance per iteration when useFakeTimers is true. Default 50. */
  timerStepMs?: number;
  /** Max number of settle-loop iterations before giving up. Default 50. */
  maxIterations?: number;
  /** Max total virtual (fake-timer) or wall-clock (real-timer) time budget in ms before giving up. Default 5000. */
  maxTimeBudgetMs?: number;
}

export interface SettleResult {
  snapshot: CommitSnapshot;
  settled: boolean;
  commits: number;
  reason?: "stable" | "iteration-limit" | "time-limit";
}

/**
 * Flush one microtask-queue's worth of pending promise callbacks. Awaiting a
 * resolved promise defers to the microtask queue exactly once per await, so
 * a handful of chained awaits reliably drains a short chain of `.then`s
 * (e.g. `query(value).then(...)`) without needing real time to pass.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

/**
 * Repeatedly advances the clock/microtask queue and watches for new commits,
 * until either no new commit occurs in an iteration (stable) or a bound is
 * exceeded (iteration count or virtual/wall time budget). Returns the last
 * observed snapshot along with whether it was reached by settling or by
 * hitting a bound — callers MUST check `settled` and must not treat an
 * unsettled result as though the transition were stable.
 */
export async function settle(options: SettleOptions): Promise<SettleResult> {
  const { useFakeTimers, timerStepMs = 50, maxIterations = 50, maxTimeBudgetMs = 5000 } = options;

  // Seed from the most recent commit observed anywhere (not just after this
  // settle() call started watching): an action performed with fireEvent/act
  // before calling settle() already committed synchronously, and settle()
  // must still be able to report that state even if nothing further happens.
  const initial = getLastCommittedRoot();
  let commitIndex = initial.commitIndex;
  let lastRoot: unknown = initial.root;
  let totalCommits = 0;
  let elapsedVirtualMs = 0;
  const wallClockStart = Date.now();

  const unsub = onCommit((root) => {
    lastRoot = root;
    commitIndex++;
    totalCommits++;
  });

  try {
    let iterations = 0;
    let reason: "stable" | "iteration-limit" | "time-limit" = "stable";
    let settled = false;

    while (true) {
      const commitsBefore = totalCommits;

      // Split into two act() calls rather than one. A timer callback that
      // synchronously calls setState and then kicks off a promise (e.g.
      // DebouncedSearch's setPhase("searching") followed by query().then(...))
      // must commit "searching" on its own before the promise's microtask
      // resolves "results" — otherwise a single act() batches both updates
      // into one commit and the intermediate phase is lost. Advancing timers
      // in a synchronous act() flushes exactly what the timer callback did
      // synchronously; draining microtasks in a second, separate act() then
      // flushes whatever those synchronous updates scheduled asynchronously.
      if (useFakeTimers) {
        // Synchronous act() call, deliberately not awaited: act's sync
        // overload flushes immediately with no promise/microtask yield
        // point, so nothing can slip out from between this call and the
        // microtask-draining act() below and get flagged as an update
        // outside act().
        act(() => {
          vi.advanceTimersByTime(timerStepMs);
        });
      }
      await act(async () => {
        await drainMicrotasks();
      });

      iterations++;
      elapsedVirtualMs = useFakeTimers ? iterations * timerStepMs : Date.now() - wallClockStart;

      // In fake-timer mode, "no commit this iteration" is not sufficient to
      // declare stability: a debounce timer may simply not have elapsed yet.
      // vi.getTimerCount() reports timers still scheduled, so we only settle
      // once both no new commit occurred AND nothing is left pending.
      const pendingTimers = useFakeTimers ? vi.getTimerCount() : 0;

      if (totalCommits === commitsBefore && pendingTimers === 0) {
        settled = true;
        reason = "stable";
        break;
      }

      if (iterations >= maxIterations) {
        reason = "iteration-limit";
        break;
      }
      if (elapsedVirtualMs >= maxTimeBudgetMs) {
        reason = "time-limit";
        break;
      }
    }

    if (lastRoot === undefined) {
      // No commit was ever observed (e.g. component never mounted through
      // this settle call). Return an empty snapshot rather than throwing;
      // callers driving a no-op action legitimately hit this.
      return {
        snapshot: { components: [], commitIndex },
        settled,
        commits: totalCommits,
        reason,
      };
    }

    return {
      snapshot: extractSnapshot(lastRoot, commitIndex),
      settled,
      commits: totalCommits,
      reason,
    };
  } finally {
    unsub();
  }
}
