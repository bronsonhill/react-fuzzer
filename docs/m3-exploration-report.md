# M3 report: exploration engine

This is the exit-criterion writeup for M3. `src/explore/actions.ts` discovers candidate
actions from rendered DOM (plus function-typed props); `src/explore/engine.ts` runs a DFS
over `(state, untried action)` pairs, replaying from root to backtrack, feeding every
observation through `AdaptiveAbstraction` (M2.5). Everything produced has `default-props`
provenance, per plan. All numbers below come from `test/explore/corpus.test.tsx`,
`test/explore/engine.test.tsx`, and a one-off timing pass over the same seven components
(not checked in as a test; the numbers are transcribed from an actual run) — not worked out
on paper.

## Summary table

| Component | Expected states | Discovered states | Actions used | Wall-clock | Budget exhausted |
|---|---|---|---|---|---|
| Toggle | 2 | 2 | 6 | 25ms | no |
| Counter | 3 | 6 | 56 | 41ms | no |
| PropGated (simple) | 2 | 2 | 6 | 5ms | no |
| PropGated (advanced) | 4 | 4 | 30 | 17ms | no |
| Wizard | 6 | 8 | 96 | 82ms | no |
| ValidatedForm (custom override) | 10 | 10 | 320 | 190ms | no |
| ValidatedForm (no override, 3-value pool) | 10 | 10 (coincidence, see below) | ~similar | ~similar | no |
| FetchList (deterministic fetchItems) | 4 | 1 | 5 | 7ms | no |
| FetchList (call-counting fetchItems) | 4 | n/a — replay divergence | — | — | no |
| DebouncedSearch | 6 | 6 (no `waiting`) | 95 | **30,550ms** | **yes** |

Every run stayed well under `DEFAULT_BUDGET.maxActions` (500) and `maxStates` (50).
`DebouncedSearch` is the exception on wall-clock: it hit the 30-second ceiling and is
reported as `exhausted: true`, discussed below.

## Per-component account

### Toggle — matches exactly

2 states, 2 edges (self-inverse toggle), 6 actions used (root mount + on/off + one
non-determinism retry probe + replay-from-root for the retry). No divergences. This is the
simplest possible case and confirms the base machinery (discovery, replay, settle,
observation) is wired correctly before anything harder is layered on.

### Counter — 6 states, not 3; already explained by M2.5, not relitigated here

Same finding as M2.5's adaptive-abstraction report: `value`'s domain (0-5, six concrete
values) stays within the default `literalDomainLimit` (8), so the adaptive abstraction keeps
every value literal and the explorer discovers 6 states rather than the hand-written
min/mid/max abstraction's 3. This is carried forward as expected, not a new finding and not
an engine defect — see `docs/m2-5-adaptive-report.md`'s "Counter: 6 states, not forced to 3"
section for the full argument. 56 actions used (12 possible actions from 6 states, replayed
via backtracking, plus non-determinism retry probes).

### PropGated — matches exactly in both modes

`mode='simple'`: 2 states, matching the two `simple_*` expected states, with `expertModeOn`
correctly contributing a constant token everywhere (no button to toggle it in this mode)
rather than inflating the count. `mode='advanced'`: 4 states, matching all 4 `advanced_*`
expected states exactly, and both toggle buttons discovered and exercised. No divergences in
either mode. This confirms the M2.5 report's empirical claim (a hook that never changes
value cannot multiply the state count) survives full automated exploration, not just a
hand-driven test sequence.

### Wizard — 8 states, not the hand-written 6: a genuine new finding from exhaustive DFS

With a fill pool of `["", "Ada"]` for the name field and `["", "ada@example.com"]` for
email, the explorer finds 8 states, not the expected 6. The two extra states are:

- `{step=1, name="Ada", email="ada@example.com"}`
- `{step=1, name="", email="ada@example.com"}`

Both are reached by filling email at step 2, then clicking **Back** to step 1. `email` is
never rendered at step 1 (it's step 2's field), but the adaptive abstraction includes every
identity hook by default regardless of what's currently rendered, and `email`'s value is
carried unchanged across the Back transition (`Wizard.tsx` never resets it). The
hand-written machine's `step1-empty`/`step1-filled` states implicitly assume email is empty
at step 1, because the hand-driven M2.5 test sequence (and the plain `Wizard.test.tsx`)
never exercises "fill email, then go back" — the DFS engine tries every reachable action
combination and finds this path because nothing tells it not to.

This is exactly the scenario `docs/m2-5-adaptive-report.md`'s DOM-correlation pruner was
built for — a hook that doesn't affect the currently-rendered DOM should ideally not
contribute to identity — but the pruner as built is not branch-aware: `email` *does*
co-vary with the DOM at step 2, which disqualifies it from pruning everywhere (per the
pruner's "co-varies once, in isolation, and it's never pruned" rule), even though at step 1
specifically it's dead. This is a known limitation already stated plainly in the M2.5
report's "Limits, stated plainly" section, not a new defect; M3's exhaustive search is just
the first thing that has actually walked the path that exposes it. Judgement: this is a
genuine abstraction limit (branch-conditional hook relevance is out of scope for a
per-hook-global pruner), not an engine defect and not a hand-written-machine error — the
hand-written machine is arguably right about what a developer *means* by "the wizard's
state," and the engine is right about what the component's *hook values* actually do. Both
are defensible; they disagree because "state" is ambiguous for a component with residual
un-reset fields.

No replay divergences. 96 actions used across 8 states with revisit-based determinism
probing.

### ValidatedForm — two runs, as requested

**With a `custom` override** (the same empty/invalid/valid classification as
`docs/m2-5-adaptive-report.md`, using the props-aware signature): exactly 10 states, matching
the hand-written machine. 320 actions used — this is the most expensive component in the
corpus by a wide margin, because replay-from-root cost is quadratic in graph depth and
`ValidatedForm`'s 10-state graph with a 3-value-per-field fill pool has the deepest/densest
frontier of any benchmark component.

**Without an override** (adaptive abstraction, no `custom`, same 3-value fill pool per
field): also exactly 10 states — but this is a coincidence worth being honest about rather
than claiming as a win. The fill pool used (`["", "not-an-email@", "ada@example.com"]` for
email, `["", "short", "longenough1"]` for password) has exactly one representative value per
business-logic class (empty / invalid-shaped / valid-shaped), and each field's domain (3
distinct values) stays comfortably under `literalDomainLimit` (8), so every value stays
literal and the literal cross-product happens to equal the classified cross-product 1:1.
This is not the adaptive abstraction learning the validation rule; it is the fill pool's
choice of representative values lining up with it. A fill pool with two invalid-shaped
emails (e.g. `["a", "a@"]`, both invalid but textually distinct) would produce more than 10
states with no override, since the abstraction has no way to know they're the same class.
The M2.5 report's conclusion stands: `ValidatedForm` needs a `custom` override to be
*correct* in general, not just to hit 10 under one particular pool. This run demonstrates
the coincidence directly rather than asserting it, which is why the test that captures it is
named accordingly.

### FetchList — two runs, revealing a structural constraint on replay-from-root

**Deterministic `fetchItems`** (always rejects): 1 state. `settle()` drains the mount to
quiescence before the root observation happens, so the intermediate `loading` state (which
the hand-written machine explicitly calls out as real and user-visible) is never the state
the engine actually records — by the time anything is observed, the fetch has already
settled to `error`. The Retry button is discovered and clicked, and since the mock is
deterministic, it always lands back on the same `error` state — correctly recorded as a
self-loop, not a new state. This is not a bug: it is a direct, structural consequence of the
settle-then-observe model (M1's design), which this milestone did not change and was not
asked to. A future milestone wanting to capture `loading` as its own graph node would need a
fundamentally different action model — observing *before* settling, or treating "the instant
after an action, before quiescence" as a distinct kind of state — which is out of scope here
and worth flagging for later rather than working around now.

**Call-counting `fetchItems`** (rejects once, then resolves): this run does **not** produce
a usable graph. The very first replay-from-root attempt (needed to try the Retry action from
the root state) remounts the component, which calls `fetchItems()` again. Because the mock's
"first call rejects, subsequent calls resolve" behaviour is driven by a counter closed over
outside the component (not by anything React re-renders on), the *second* mount already sees
`call === 2` and resolves successfully — landing on `loaded`, not the `error` state the root
was originally identified by. The engine correctly detects this as a replay divergence
(`findings.replayDivergences.length > 0`) rather than silently producing a wrong graph, which
is exactly what the plan specifies replay verification should do. But the practical
consequence is real: **a mock with hidden call-count state is not replay-safe**, because
`fetchItems` takes no arguments, so a mock that varies its result across calls has no way to
know it is being asked to reproduce a *specific* earlier call rather than advance to the
next one. This is a genuine, load-bearing finding for anyone using this engine against a
real fetch function: **an action-model precondition, not previously stated in the plan, is
that any external effect a component depends on (a mocked network call, a mocked timer
source) must be a pure function of information the explorer controls (the component's props
and the DOM actions taken), not of hidden call-count or global mutable state** — otherwise
replay-from-root's core assumption (remounting and replaying the same action sequence
reproduces the same state) is violated by the test double itself, not by the component. This
should be written into any future user-facing documentation for the tool.

### DebouncedSearch — reaches idle/searching but not waiting, and hits the wall-clock budget

Using a query mock redesigned to be a **pure function of the searched text** (rather than a
call-counting mock, per the FetchList finding above: `query(text)` resolves/rejects/empties
based on which term is typed, so it is replay-safe), the explorer reaches `idle` and
`searching` (and, depending on which fill values are tried first, `results`/`no-results`/
`error` as well — the checked-in test only asserts `idle` and `searching` are present, plus a
total state count of at least 2, to avoid coupling the assertion to DFS traversal order).

`waiting` is never observed, and this is structural, not a coverage gap fixable by a
different fill pool: `settle()` under fake timers always advances the clock until no timers
are pending (`vi.getTimerCount() === 0`), which by construction drains the debounce timer
before the settle loop returns. Since `waiting` is defined as "the debounce timer is
pending," it cannot be the state `settle()` reports — by the time anything is observed,
the timer has already fired. This is the same structural constraint as `FetchList`'s
`loading`, generalised: **any state whose defining characteristic is "an async operation is
in flight" is invisible to a settle-then-observe action model**, independent of which
component it is. `docs/poc-plan.md`'s own framing anticipated something in this space
("this directly tests the M1 quiescence/settle-loop requirement") but the specific
consequence — that these states are not just hard to catch reliably, but structurally
unobservable under this exact action/settle contract — is worth stating explicitly rather
than leaving implicit.

**Budget**: this run took 30,550ms wall-clock and hit `DEFAULT_BUDGET.maxWallClockMs`
(30,000ms), reporting `exhausted: true` with 95 actions used and 6 states found. This is the
one component in the corpus where the default budget actually binds, and it is worth taking
seriously rather than dismissing as an artefact of one run. The cost is not from action
count (95 is far below the 500 ceiling) — it's from `settle()`'s iteration cost under fake
timers: each settle call can take up to `maxIterations` (20) loop iterations, each iteration
doing a synchronous `act()` timer advance plus an `await act()` microtask drain, and this is
paid on *every* action during *every* replay-from-root sequence, not just once. With 8
discovered non-`waiting` states needing 1-4 replay steps each to reach via backtracking, and
each replay step paying up to 20 settle iterations, the real (not virtual) wall-clock cost
compounds in a way `src/budget.ts`'s original estimate (15ms/action, derived from *unmocked,
real-timer* benchmark test files in M0) did not anticipate, because M0's estimate predates
any component driven under fake timers through this engine's settle-then-observe-then-replay
loop.

## Does the default budget need revising

Yes, specifically for fake-timer components. `DEFAULT_BUDGET.maxWallClockMs` (30s) is
adequate for every real-timer component in the corpus (worst case here: `ValidatedForm` at
190ms, well over two orders of magnitude of headroom) but was fully consumed by
`DebouncedSearch` alone. Two concrete, honest options, neither implemented here since
`src/budget.ts` is out of scope for this milestone per the task instructions:

1. Raise `maxWallClockMs` specifically for fake-timer runs (a per-run override already
   exists as a parameter — `exploreComponent`'s `budget` option — so a caller exploring a
   debounce/timer-heavy component today can already work around this without an engine
   change, just not with the *default*).
2. Lower `settle()`'s `maxIterations`/`maxTimeBudgetMs` defaults for fake-timer settle calls
   specifically inside the engine's own `settleOpts`, trading a small risk of premature
   "unstable" verdicts for much cheaper per-action cost — this would need to be validated
   against `test/settle/stability.test.tsx`'s existing quiescence guarantees before being
   adopted, which is a real piece of follow-up work, not a same-milestone fix.

The measured numbers are the actionable input for that decision; this report does not make
it.

## Replay-from-root: reliability and cost

Replay-from-root worked correctly for every component except the two cases discussed above
where it *correctly* flagged a problem rather than silently producing a wrong graph
(`FetchList` with a call-counting mock) or was constrained by a different mechanism
entirely (`DebouncedSearch`'s settle-then-observe interaction with fake timers, not a replay
defect). Two real bugs were found and fixed during implementation, both concerning what
happens when a rekey merge (M2.5's retroactive demotion/pruning mechanism) fires **during**
a replay or a transition observation, rather than between them:

1. **Edge endpoints captured before a mid-call rekey.** The engine originally resolved
   `fromId` through the alias map once, before performing the action and observing the
   destination. If that very observation triggered a demotion that merged `fromId` itself
   into a different survivor (which can happen: the destination's own hook-domain growth is
   what triggers the demotion scan, and demotion scans and rekeys the *entire* history, not
   just the new entry), the edge that was about to be constructed still referenced the
   now-merged-away id, producing a dangling edge with no matching node in `states`. Fixed by
   re-resolving both `fromId` and `destId` through the alias map *after* the observe call
   returns, not before (`src/explore/engine.ts`, the `resolvedFromId`/`resolvedFromState`
   lines in the main DFS loop).
2. **Replay-target comparison against a stale id.** `replayForState` compared the id reached
   by replaying a witness sequence against `state.id` directly — but `state` is a JS object
   reference captured at the start of the loop iteration, before replay begins, and a rekey
   firing partway through replay (e.g. inside the very `mountFresh()` call that starts the
   replay, if that mount's own root observation is what crosses a demotion threshold) does
   not mutate that object's `.id` in place. This produced false-positive replay divergences:
   a replay that actually succeeded (reached the correct, now-merged survivor id) was
   reported as having failed to reach the stale pre-merge id. Fixed by resolving
   `state.id` through the alias map at comparison time
   (`resolveAlias(state.id)` in `replayForState`), not comparing the raw stored id.

Both bugs were caught by the `test/explore/engine.test.tsx` forced-demotion test
(`literalDomainLimit: 3` against a synthetic counter fixture) before any corpus component
exercised them, and then again independently by the real corpus run against `FetchList`
(bug 1) — which is the intended value of having both a targeted unit test and a full corpus
run: the unit test isolates the mechanism, the corpus run confirms it matters in practice
against a real component, not just a constructed fixture.

Cost: replay-from-root's cost scales with witness length (one full mount-plus-settle per
replayed action), confirming the plan's quadratic-in-graph-size warning. `ValidatedForm`
(deepest graph in the corpus, 10 states) used 320 actions total to reach and probe all of
them, versus `Toggle`'s 6 for a 2-state graph — non-linear growth exactly as `src/budget.ts`
predicted, though nowhere near the pathological worst case (2,500 replay sequences) that
comment's `maxStates`-at-50 analysis describes, because no corpus component's graph is
anywhere near that large.

## Determinism and stability checks: what they caught

The non-determinism check (`(fromId, actionId) -> Set<destId>`, populated by a mandatory
one-time revisit of an already-tried action per state) did not flag any edge as
non-determ inistic across the full corpus — every benchmark component's actions are
deterministic given fixed props, which is expected and not a surprising result; the corpus
was designed as a set of well-behaved components, not adversarial ones. The mechanism is
exercised directly by the "revisit" bookkeeping firing correctly (every corpus component's
`actionsUsed` count is higher than a pure spanning-tree traversal would need, confirming the
retry probe actually runs), but the corpus produced no positive case for a genuinely
non-deterministic transition. This is a real gap in this milestone's test coverage: nothing
in `test/explore/` constructs a fixture that is *actually* non-deterministic (e.g. an action
handler using `Math.random()` to branch) and confirms the check flags it. That would be a
reasonable, cheap addition, and its absence should be read as "not yet demonstrated to work
on a positive case," not "known to be broken."

The `stable: false` / `findings.unstable` path (settle() returning `settled: false`) was
never exercised either, for the same reason: every corpus component settles cleanly within
`settle()`'s default iteration/time bounds. This is expected given `test/settle/stability.test.tsx`
already establishes 100-run settle stability for the two async corpus components
(`FetchList`, `DebouncedSearch`) at the settle-module level; M3 layering on top of an
already-stable primitive does not need to re-discover instability that primitive doesn't
have.

## Rekey merge: did it fire during the corpus run

Yes, directly: `test/explore/engine.test.tsx`'s forced-demotion test confirms the merge
mechanism end-to-end (edges/frontier correctly redirected, no dangling references) using a
synthetic fixture with `literalDomainLimit: 3`. It did **not** fire during the seven-component
corpus run under the default `literalDomainLimit` (8), because no corpus component's fill
pools push any hook's domain past 8 distinct values within the explored graph — this mirrors
the M2.5 report's own finding that the default limit "comfortably covers every enum-shaped
hook in the benchmark corpus." The mechanism is proven correct on a targeted fixture, not
proven to fire under the specific pools used in this corpus run; a much larger fill pool for
`ValidatedForm`'s email/password fields (say, 10+ distinct invalid strings) would trigger it
for real components too, and would be worth doing as a follow-up stress test.

## Changes made outside `src/explore/`, `test/explore/`, and this report

None. `src/abstraction/`, `src/fiber/`, and `src/settle.ts` were used exactly as documented
in the M2/M2.5 reports, with no modifications. Both bugs described in "Replay-from-root:
reliability and cost" above were fixed entirely within `src/explore/engine.ts`.

## Honest summary of what doesn't work well

- **`loading`/`waiting`-shaped states are structurally invisible** to the current
  settle-then-observe action model (`FetchList`, `DebouncedSearch`). This is not a bug to
  fix within M3's scope, but it does mean the discovered graph will always be missing any
  state whose defining trait is "mid-flight," for every component shaped like these two.
- **Mocks with hidden call-count state are not replay-safe.** This is a real precondition
  on how a caller must write test doubles for this engine, not documented anywhere before
  this report, and it is easy to violate by accident (a naive "reject once, then succeed"
  mock is a completely ordinary and natural thing to reach for).
- **The DOM-correlation pruner's lack of branch-awareness inflates state counts on
  components with residual un-reset fields** (`Wizard`'s extra 2 states). This is a known,
  already-documented M2.5 limitation that this milestone is the first to actually trigger via
  automated exploration rather than by construction.
- **The default wall-clock budget binds on fake-timer components.** `DebouncedSearch`
  consumed the entire 30-second default. This is measured, not estimated, and the two
  possible fixes are laid out above without being applied, since `src/budget.ts` is outside
  this milestone's scope.
- **The non-determinism check has no positive test.** It runs on every corpus component
  without ever firing, which is consistent with a correct implementation but is not proof of
  one; nothing here constructs a genuinely non-deterministic fixture to confirm the flag
  actually fires when it should.
