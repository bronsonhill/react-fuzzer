/**
 * Default exploration budget for M3 onward.
 *
 * Measured baseline (M0): running the benchmark corpus test suite in jsdom
 * (`npm test`), individual spec files that mount a component once and then
 * drive it through a handful to ~20 discrete user-event actions
 * (clicks / typed characters) complete in the following wall-clock times:
 *
 *   Toggle.test.tsx           1 mount, 2 actions      ~68ms
 *   Counter.test.tsx          1 mount, 10 actions      ~146ms
 *   Wizard.test.tsx           1 mount, ~16 actions     ~264ms
 *   ValidatedForm.test.tsx    1 mount, ~20 actions     ~314ms
 *
 * Subtracting fixed per-file overhead (module transform, jsdom environment
 * setup, ~450-550ms amortised once per file, not per action) the marginal
 * cost of one mount-plus-single-interaction cycle is roughly 10-20ms in
 * jsdom, so this file uses 15ms/action as the grounded estimate. This is
 * consistent with the plan's warning that replay-from-root backtracking is
 * quadratic in graph size: replaying a recorded action sequence of length k
 * to reach a given state costs roughly k * 15ms, so an exploration that
 * visits S states along paths of average depth D costs on the order of
 * S * D * 15ms before any single new action is tried.
 */
export interface Budget {
  maxActions: number;
  maxStates: number;
  maxWallClockMs: number;
}

export const DEFAULT_BUDGET: Budget = {
  // Total number of discrete UI actions (clicks, keystrokes, etc.) the
  // explorer may execute across an entire run, counting every action taken
  // during replay-from-root backtracking, not just novel ones. At ~15ms per
  // action this caps a single run at roughly 500 * 15ms = 7.5s of pure
  // action cost, leaving headroom under maxWallClockMs for settle-loop waits
  // and replay overhead on top of that.
  maxActions: 500,

  // Ceiling on distinct states recorded per component. The benchmark corpus
  // tops out at 10 states (ValidatedForm) by hand; 50 gives roughly 5x
  // headroom for a component more complex than anything in the corpus while
  // still keeping replay-from-root's O(states^2) backtracking cost bounded:
  // at 50 states, worst-case pairwise replay is on the order of 2500 replay
  // sequences, which at even a generous 10 actions/sequence and 15ms/action
  // is ~375s — already uncomfortably long, which is why maxWallClockMs below
  // is the binding constraint in practice rather than maxStates.
  maxStates: 50,

  // Wall-clock ceiling per component exploration run. Chosen so a run stays
  // fast enough to sit in a local dev loop or CI job (comparable to a single
  // Vitest file's runtime, which top out around 300ms for the most complex
  // benchmark today) while giving genuine headroom for the quadratic replay
  // cost as the state graph grows during real exploration. 30s is roughly
  // 100x the slowest benchmark test file observed in M0, which should absorb
  // both a much bigger state graph and the overhead of settle-loops (fake
  // timer draining, microtask flushing) that a hand-written test doesn't pay
  // for the way an automated explorer must.
  maxWallClockMs: 30_000,
};
