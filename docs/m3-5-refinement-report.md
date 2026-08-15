# M3.5 report: exploration engine refinement

This is the exit-criterion writeup for M3.5, which addresses three problems the M3 report
(`docs/m3-exploration-report.md`) identified but did not fix: transient states being
structurally invisible to a settle-then-observe action model, a wall-clock outlier on
`DebouncedSearch`, and a DOM-correlation-pruner limitation that inflates `Wizard`'s state
count. All numbers below come from `test/explore/corpus.test.tsx`,
`test/settle/commit-chain.test.tsx`, `test/explore/transient.test.tsx`, and a one-off timing
pass over the full seven-component corpus (not checked in as a test; transcribed from an
actual run using `performance.now()`, not estimated).

## Problem 1: transient states

### The fix

`settle()` (`src/settle.ts`) now returns `commits: ObservedCommit[]`, the full ordered
sequence of every commit it observes, from the snapshot already in place when it started
watching (`driver: "initial"`) through to the final settled snapshot. Each subsequent entry
is tagged with what drove it: `"timer"` if it appeared during a settle iteration's
synchronous fake-timer advance, `"microtask"` if it appeared during that same iteration's
microtask-drain. Under real timers there is no synchronous/microtask split visible from
outside `act()`, so every non-initial commit is honestly tagged `"microtask"` there rather
than guessing. The existing `snapshot` field (the final commit) is unchanged, so nothing that
only reads it broke.

Fidelity matters here: by the time `settle()` returns, the DOM only reflects the *final*
commit, so a per-commit DOM fingerprint can't be computed after the fact. `SettleOptions`
therefore gained an `onCommit` callback, invoked synchronously as each commit lands (React
has already applied that commit's DOM mutations by the time it calls into the devtools hook),
so a caller that owns the live container can read the DOM at exactly the right moment.

The exploration engine (`src/explore/engine.ts`) uses this via `collectChain()` +
`processChain()`: every commit in a settle() call's chain is abstracted into its own state.
The first chain entry is reached via the triggering user action (or is the root, for the
initial mount); every subsequent entry is an **automatic** transition from the previous one.
Edges now carry a `kind: "user" | "auto"` (`src/explore/graph.ts`); `auto` edges carry a
`driver: "timer" | "microtask"` instead of an `ActionRef`.

### The transient-state rule

Only the *last* commit in a chain is treated as a state exploration can act from. Every
earlier commit is marked `transient: true` on its `StateNode`, and its actions are never
seeded onto the DFS frontier. The reasoning: `settle()`'s contract is "run to quiescence,"
and there is no way to ask it to stop early at an intermediate commit and hold the component
there while a discovered action is tried — the very next line of the settle loop will already
have advanced past it. Seeding actions from a transient state would mean pretending the
explorer could reliably reproduce "click this button 4ms into a fetch, before it resolves,"
which nothing in this architecture can actually do; treating it as an ordinary frontier node
would multiply the graph with edges that don't correspond to anything replay-from-root could
verify, since replaying the witness and settling would run straight past the transient point
every time.

The rule is not permanent, though: a state id observed only as an intermediate commit in one
chain can later be observed as the *actual* settle-endpoint of a different chain (a different
action sequence genuinely stops there). When that happens the engine reclassifies it
(`transient: false`) and seeds its actions retroactively — tracked via a `settledStateIds` set
that every chain's final step adds to, checked before deciding whether an intermediate step
should be marked transient. `test/explore/transient.test.tsx`'s third test pins down that this
reclassification is conditional, not automatic promotion of every transient state.

A `StateNode` reached only via auto edges keeps `default-props` provenance and its witness is
the same action sequence that would reach its settled successor, plus a `note` field
explaining that the state isn't independently reachable by replay (since replaying those
actions and settling lands on the *final* chain state, not the intermediate one). This is
intentionally honest rather than fabricating a fake standalone witness.

One gap, stated plainly: if a rekey merge (`AdaptiveAbstraction`'s retroactive
demotion/pruning) collapses a transient-loser id into a survivor that should now count as
settled, the merge callback flips the survivor's `transient` flag but cannot retroactively
seed its actions, because no live container for that survivor is available inside the rekey
callback. This is a narrow edge case (a rekey firing exactly when a transient/settled pair
merge) not exercised by the corpus, documented in `src/explore/engine.ts`'s `onRekey` handler
rather than silently accepted.

### Results

| Component | Before (M3) | After (M3.5) |
|---|---|---|
| FetchList (deterministic) | 1 state (`error` only); `loading` invisible | 2 states: `loading` (transient) —auto→ `error` (settled); Retry loops `error` —user→ `loading` |
| DebouncedSearch | 6 states, `waiting` never observed | 18 states (12 transient: `waiting`/`searching` per typed term), `waiting` —auto(timer)→ `searching` —auto(microtask)→ settled outcome |

Both components now discover the expected transient states from their `.expected.ts`
machines. `FetchList`'s 2 discovered states plus its Retry self-loop-through-`loading` cover
all 4 of the hand-written machine's states in spirit — `empty`/`loaded` weren't independently
exercised here only because this run's `fetchItems` mock always rejects (a fixed test-mock
choice, not an engine limitation; the call-counting-mock test in the same file already shows
why a mock varying its result across calls is a separate, orthogonal problem). `DebouncedSearch`
now reaches `waiting` and `searching` for every typed term, each correctly transient, chaining
via `auto` edges into whichever settled outcome (`results`/`no-results`/`error`) that term
resolves to — matching the expected machine's `waiting → searching → {results, no-results,
error}` shape exactly, including the driver split (`timer` for the debounce firing,
`microtask` for the query promise resolving).

`test/explore/corpus.test.tsx`'s old assertions for these two components ("finds exactly 1
state," "`waiting` is never observed") were testing a real gap, not a designed behaviour —
they were updated to the corrected expectations, not loosened. This is stated explicitly per
the task's instruction to flag any assertion change: the old text is retained in a comment
next to each replacement, and both replacements assert the specific new mechanism (transient
flag, edge kind, driver) rather than just a bigger state count, so a future regression back to
the M3 behaviour would still fail loudly.

## Problem 2: wall-clock cost

### What was actually wrong

The M3 report attributed `DebouncedSearch`'s 30,550ms figure to "settle-loop iteration cost
compounding across replay" and proposed two speculative fixes: replay-specific timer
aggressiveness, and `vi.advanceTimersToNextTimer()` in place of fixed-size steps. Both were
implemented (see below) and had a real but modest effect — a few percent, not two orders of
magnitude. The actual cause was different and much simpler: **`exploreComponent`'s own
wall-clock budget tracking used `Date.now()`, which `vi.useFakeTimers()` mocks.** Under fake
timers, `Date.now()` reflects *virtual* time, which advances by 300ms every time
`DebouncedSearch`'s debounce timer fires — not real elapsed wall-clock time. With dozens of
debounce firings across a DFS run's backtracking, virtual time accumulates far faster than
real time, and `budgetExhausted()`'s `Date.now() - startTime >= budget.maxWallClockMs` check
was comparing a virtual-time delta against a real-time budget, hitting the 30,000ms ceiling
long before any real 30 seconds had passed. The "30,550ms" in the M3 report was never a
measurement of how long the tool actually took; it was virtual clock drift.

The fix: `startTime`, `budgetExhausted()`, and the final `elapsedMs` in `src/explore/engine.ts`
now use `performance.now()` instead of `Date.now()`. `performance.now()` is not in
`vi.useFakeTimers()`'s default fake list, so it stays tied to the real clock regardless of
fake-timer state — this is the actual fix, and it alone would have resolved the reported
budget exhaustion.

The two speculative fixes from the M3 report were still implemented, since they are
independently real (if smaller) improvements and the task asked for them to be tried:

1. **`timerAdvance: "next-timer"`**: `settle()` gained a `timerAdvance` option
   (`"fixed"` | `"next-timer"`). `"next-timer"` calls `vi.advanceTimersToNextTimer()` instead
   of `vi.advanceTimersByTime(timerStepMs)`, jumping straight to whichever fake timer is due
   next rather than stepping through `timerStepMs` at a time. This does not change which
   commits are observed (nothing about which commits fire depends on how many virtual
   milliseconds were skipped to get there — confirmed directly by
   `test/settle/commit-chain.test.tsx`'s "next-timer reaches the same final snapshot" test),
   so the engine now defaults to it everywhere (`settleOpts` in `exploreComponent`), not just
   during replay. The one place this is deliberately *not* the default is
   `test/settle/settle.test.tsx`'s direct `settle()` tests, which exercise fixed-step
   iteration budgeting on purpose and call `settle()` directly rather than through the engine,
   so they are unaffected by this engine-level default.
2. **Replay-specific settle options**: replay-from-root's `mountFreshFast`/
   `performAndObserveFast` (used only inside `replayForState`, where the destination is
   already known and only needs verifying) use `replaySettleOpts`, layered on the same
   `next-timer` default.

Measured separately (via `test/settle/_chain`-style direct `settle()` timing, not checked in):
a single settle() call for `DebouncedSearch`'s debounce-then-resolve sequence took ~350ms real
wall-clock with fixed 50ms stepping and ~300ms with next-timer — a real but small difference,
because the dominant real-time cost per settle() call is `act()`/jsdom overhead per iteration
(tens of milliseconds), not the number of virtual milliseconds skipped. This confirms the
`Date.now()`-mocking bug, not iteration-count inefficiency, was the actual driver of the
30-second figure: shaving one iteration off a handful of settle() calls could never have
closed a 150x gap; fixing which clock the budget check reads did.

### Before/after

| Component | M3 wall-clock | M3.5 wall-clock (real, `performance.now()`-measured) | M3 exhausted | M3.5 exhausted |
|---|---|---|---|---|
| Toggle | 25ms | 29.6ms | no | no |
| Counter | 41ms | 46.4ms | no | no |
| PropGated (simple) | 5ms | 5.1ms | no | no |
| PropGated (advanced) | 17ms | 15.3ms | no | no |
| Wizard | 82ms | 79.7ms | no | no |
| ValidatedForm (custom override) | 190ms | 185.9ms | no | no |
| FetchList (deterministic) | 7ms | 10.7ms | no | no |
| DebouncedSearch | **30,550ms** | **90.6ms** | **yes** | no |

The small increases on some components (Counter, Toggle, FetchList) are the state-graph
getting slightly bigger from transient-state discovery (FetchList: 1→2 states, extra chain
processing) and are within normal run-to-run jsdom variance, not a regression worth chasing.
`DebouncedSearch` is the only component whose number changed by more than noise, and it moved
in the intended direction by three orders of magnitude, not because the tool got faster in
some general sense but because the number being reported was never real wall-clock time to
begin with.

### Does the default budget need revising

No. With the actual bug fixed, every corpus component finishes in well under 200ms, two
orders of magnitude under `DEFAULT_BUDGET.maxWallClockMs` (30,000ms). `src/budget.ts` is left
unchanged; revising it would have been the wrong move here since the ceiling was never the
problem, the clock feeding it was.

## Problem 3: branch-aware DOM pruning on Wizard

Re-ran the same `Wizard` exploration under M3.5 (fill pools unchanged) and it still finds
exactly 8 states, unaffected by the transient-state work — `Wizard` is fully synchronous, so
every settle() chain is a single commit and there is nothing for the new machinery to change
here. This was worth checking rather than assuming, since M3.5's changes touch a lot of
`engine.ts`.

Judgement, as requested: **I agree with the M3 report's original assessment — the two extra
states are genuinely real, not noise.** `{step=1, name="Ada", email="ada@example.com"}` and
`{step=1, name="", email="ada@example.com"}` are both states a user can actually put the
component into (fill email at step 2, click Back), and the component's own code confirms it:
`Wizard.tsx` never resets `email` on Back, so the field's value genuinely persists into step
1's hook state even though step 1's rendered DOM has no email input to show it in. The
hand-written machine's `step1-empty`/`step1-filled` states implicitly assume email is always
empty at step 1 because no hand-driven test sequence ever tried "fill email, then go back" —
that's a gap in the hand-written machine's coverage of the component's actual reachable state
space, not a gap in what the tool found. A developer reading this discovered pair would
learn something true and possibly useful (email survives navigating back, which could be
either intended UX or an oversight depending on the product's requirements) that the
hand-written machine's authors did not consider.

I did not implement per-state-context (branch-aware) pruning to suppress these two states.
Doing so would mean deciding that "email doesn't affect this particular render" should
override "email is part of this component's actual persisted state" — but the second claim
is the more defensible one for a tool whose job is to report what a component's hooks
actually do, not to guess at what a developer meant by "the wizard's logical steps." If a
future milestone wants a *coarser*, DOM-only view of state for a different purpose (e.g. a
report meant for someone who only cares about what's on screen, not what's tracked
internally), that should be a separate, explicitly-opted-into abstraction mode, not a
correction folded into the default pruner. Changing the pruner's default behaviour to hide
this would make the tool actively *worse* at its stated job of exhaustive discovery, in
exchange for matching one hand-written reference machine that the tool's own DFS already
demonstrated is incomplete.

## What this changes about the outlook for M4 and M5

- **M4 (prop generation)** benefits directly from Problem 2's fix: the real, not virtual,
  wall-clock budget was the thing standing between "one fixed props run" and "many props runs
  needed for generation," and it turns out there was much more headroom than the M3 numbers
  suggested. A component with fake timers is no longer a 150x-more-expensive case to budget
  for; every corpus component now costs the same order of magnitude regardless of real vs.
  fake timers. M4 should still watch for the *transient*-state count multiplying faster than
  the settled-state count on components with longer async chains (more `.then()` steps, more
  timers) — the transient/settled split in the numbers above (DebouncedSearch: 12
  transient/6 settled) is worth tracking as a health metric as prop generation multiplies the
  number of distinct settled leaves explored.
- **M5 (the report)** needs to decide how to *present* transient states to a developer. They
  are real and useful (a developer very much wants to know their component has a `loading`
  state), but they are not independently reachable/replayable the way settled states are, and
  a report that doesn't distinguish "you can stop here and interact" from "the component
  passes through here on the way to X" would be misleading. The `transient` flag and the
  `kind`/`driver` split on edges (`src/explore/graph.ts`) already carry exactly the
  information M5 needs to render this distinction (e.g. a dashed/greyed node for transient
  states, solid for settled ones, with auto edges labelled by their driver) without further
  engine changes.
- **The M2.5 pruner limitation (Problem 3) remains open** exactly as characterised in the M2.5
  and M3 reports, and this milestone's judgement is that it should stay open by design rather
  than be patched around — a future milestone building a "developer-facing simplification"
  view on top of the exhaustive graph is a more honest place to address it than tightening the
  identity/pruning logic that decides what counts as a distinct state in the first place.

## Changes made

- `src/settle.ts`: `SettleResult` gained `commits: ObservedCommit[]` (the full per-commit
  chain, each tagged with a `CommitDriver`) and `commitCount: number` (renamed from the old
  `commits: number`, since that name now belongs to the chain array); `SettleOptions` gained
  `timerAdvance` and `onCommit`. The `snapshot` field is unchanged and still equals the last
  chain entry's snapshot.
- `src/explore/graph.ts`: `Edge` gained `kind: "user" | "auto"` and `driver?: "timer" |
  "microtask"`; `action` is now optional (present only on `user` edges). `StateNode` gained
  `transient?: boolean` and `witness.note?: string`.
- `src/explore/engine.ts`: root mount and the main DFS action step now use `collectChain()` +
  `processChain()` for full per-commit fidelity; replay-from-root uses the faster
  `mountFreshFast()`/`performAndObserveFast()` pair (final-snapshot-only, `next-timer` timer
  advance) since replay only needs to verify a known destination. Wall-clock budget tracking
  switched from `Date.now()` to `performance.now()`.
- `test/explore/corpus.test.tsx`: the `FetchList` (deterministic) and `DebouncedSearch`
  assertions were updated to the corrected expectations (see Problem 1 above); both changes
  are explicitly commented as corrections, not loosenings, with the reasoning inline.
- `test/settle/commit-chain.test.tsx` (new): unit tests for the commit-chain observation --
  driver tagging, `next-timer` producing the same chain as fixed stepping.
- `test/explore/transient.test.tsx` (new): unit tests for the transient-state rule -- no
  seeded/user edges from a transient state, the reclassification condition, and the
  auto-vs-user edge shape invariants (`driver` xor `action`).
- No other files were touched. `src/abstraction/`, `src/fiber/`, `src/budget.ts`, and every
  benchmark/`.expected.ts` file are unchanged.

## Honest summary of what doesn't fully work

- The rekey-merge/transient-reclassification interaction (a transient-loser id merging into a
  survivor that should become settled) flips the flag correctly but cannot retroactively seed
  actions without a live container, as noted above. Not exercised by the corpus; a real gap
  if a future component's fill pool happens to trigger it.
- `FetchList`'s `empty`/`loaded` states are not independently demonstrated in the checked-in
  deterministic-mock test (it always rejects), so the auto-edge machinery is verified for the
  `error` branch specifically. `test/settle/commit-chain.test.tsx` and
  `test/explore/transient.test.tsx` exercise the mechanism generically enough that this is a
  coverage gap in which *branch* was exercised, not evidence the other branches behave
  differently — but it wasn't independently checked against a resolving mock in this
  milestone's added tests.
- Problem 3 remains open by deliberate choice, not oversight; see above.
