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
  /** Milliseconds of virtual time to advance per iteration when useFakeTimers is true and timerAdvance is "fixed". Default 50. */
  timerStepMs?: number;
  /**
   * How each fake-timer iteration advances the clock. `"fixed"` (the
   * default) advances by exactly `timerStepMs` every iteration, which is
   * what lets a caller reliably observe a value that only holds true for a
   * narrow virtual-time window (see the iteration-limit test in
   * test/settle/settle.test.tsx). `"next-timer"` instead jumps straight to
   * whichever pending timer is due to fire next
   * (`vi.advanceTimersToNextTimer()`), skipping the empty steps in between —
   * far cheaper when the caller only cares about reaching quiescence (e.g.
   * replay-from-root verifying it lands on an already-known destination
   * state) rather than sampling every narrow intermediate window. Ignored
   * when useFakeTimers is false.
   */
  timerAdvance?: "fixed" | "next-timer";
  /** Max number of settle-loop iterations before giving up. Default 50. */
  maxIterations?: number;
  /** Max total virtual (fake-timer) or wall-clock (real-timer) time budget in ms before giving up. Default 5000. */
  maxTimeBudgetMs?: number;
  /**
   * Invoked synchronously for every commit this settle() call observes,
   * including the initial one, in order, before any further advancing
   * happens. Exists so a caller that also owns the live DOM container (e.g.
   * the exploration engine) can inspect the DOM at exactly the moment each
   * commit landed — by the time settle() *returns*, the DOM already reflects
   * only the final commit, so any per-intermediate-commit DOM inspection
   * (e.g. computing a DOM fingerprint) must happen from inside this hook,
   * not after the fact.
   */
  onCommit?: (commit: ObservedCommit) => void;
}

/**
 * One commit observed during a settle() call, tagged with what (as far as
 * settle() can honestly tell) drove it. `"initial"` is the snapshot already
 * committed by the time settle() started watching (i.e. whatever the
 * caller's own synchronous action, such as fireEvent, already produced).
 * `"timer"` means it appeared during the synchronous fake-timer advance of a
 * settle iteration; `"microtask"` means it appeared during that same
 * iteration's microtask-draining act() call instead. Under real timers
 * (`useFakeTimers: false`) there is no synchronous/microtask split to
 * observe from outside, so every non-initial commit is tagged
 * `"microtask"` — an honest "we drained real time and a promise resolved
 * or a real timer fired," not a real distinction between the two.
 */
export type CommitDriver = "initial" | "timer" | "microtask";

export interface ObservedCommit {
  snapshot: CommitSnapshot;
  driver: CommitDriver;
}

export interface SettleResult {
  /** The final observed snapshot. Equal to `commits[commits.length - 1].snapshot`. */
  snapshot: CommitSnapshot;
  /**
   * The ordered sequence of every commit observed by this settle() call,
   * from the snapshot already in place when settle() started watching
   * (`driver: "initial"`) through to the final settled snapshot. Always has
   * at least one entry when a component is mounted. Callers that only need
   * the previous single-snapshot behaviour can keep using `snapshot`; this
   * exists so the caller can turn each intermediate commit into its own
   * observation instead of only ever seeing the last one.
   */
  commits: ObservedCommit[];
  settled: boolean;
  /** Total number of *new* commits observed while this settle() call was actively watching (excludes the initial one). */
  commitCount: number;
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
  const { useFakeTimers, timerStepMs = 50, timerAdvance = "fixed", maxIterations = 50, maxTimeBudgetMs = 5000 } = options;

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

  const chain: ObservedCommit[] = [];
  if (initial.root !== undefined) {
    const initialCommit: ObservedCommit = { snapshot: extractSnapshot(initial.root, commitIndex), driver: "initial" };
    chain.push(initialCommit);
    options.onCommit?.(initialCommit);
  }

  // Tags the driver of whatever commit(s) land during the current phase of
  // the current iteration. Real timers have no synchronous/microtask split
  // visible from here, so every non-initial commit is tagged "microtask" in
  // that mode (see CommitDriver's doc comment for the honesty caveat).
  let currentDriver: CommitDriver = "microtask";

  const unsub = onCommit((root) => {
    lastRoot = root;
    commitIndex++;
    totalCommits++;
    const commit: ObservedCommit = { snapshot: extractSnapshot(root, commitIndex), driver: currentDriver };
    chain.push(commit);
    options.onCommit?.(commit);
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
        currentDriver = "timer";
        act(() => {
          if (timerAdvance === "next-timer") {
            if (vi.getTimerCount() > 0) vi.advanceTimersToNextTimer();
          } else {
            vi.advanceTimersByTime(timerStepMs);
          }
        });
      }
      currentDriver = "microtask";
      await act(async () => {
        await drainMicrotasks();
      });

      iterations++;
      // Date.now() is mocked by vi.useFakeTimers() and advances in step with
      // vi.advanceTimersByTime()/advanceTimersToNextTimer(), so this is an
      // accurate virtual-time reading in both "fixed" and "next-timer" mode
      // — unlike `iterations * timerStepMs`, which is only accurate for
      // fixed-step advancement.
      elapsedVirtualMs = Date.now() - wallClockStart;

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
      const empty: CommitSnapshot = { components: [], commitIndex };
      return {
        snapshot: empty,
        commits: [{ snapshot: empty, driver: "initial" }],
        settled,
        commitCount: totalCommits,
        reason,
      };
    }

    return {
      snapshot: chain[chain.length - 1]!.snapshot,
      commits: chain,
      settled,
      commitCount: totalCommits,
      reason,
    };
  } finally {
    unsub();
  }
}
