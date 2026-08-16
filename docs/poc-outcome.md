# PoC outcome: closing assessment

Six milestones (M0-M6, M2.5 and M3.5 as unplanned mid-course corrections) produced a tool
that mounts a React component, explores it by generating props and driving interactions,
derives a state graph from observed hook values, renders it for human review, and now
diffs a later run against a developer-approved baseline. This document is the honest
close-out: what the evidence across `docs/m0`-`docs/m6` reports actually supports, where
it doesn't, and what a skeptical reviewer should point at first.

## What this tool does that nothing else does

`@xstate/test` and `react-automata` both require a hand-written model up front and derive
*tests* from it — they check that a component's behaviour matches a model a developer
already wrote, which presupposes the developer already knows and has encoded the state
machine correctly. `fast-check-frontend` generates interaction sequences and checks
invariants, but produces no model at all — it can tell you a property held or failed, not
what the states were.

This tool inverts the first relationship and completes the second: it derives the model
*from* the component (via hook-value identity, replay-from-root exploration, and
provenance-tagged prop generation) and hands it to a developer to review and approve,
rather than requiring the model as an input. The concrete evidence this actually surfaces
information a developer wouldn't otherwise have without reading source: `PropGated`'s
report (docs/m5-report-notes.md) correctly separates two states reachable under the
example props from two more reachable only under `mode="advanced"`, and names `mode` as
the responsible prop — a fact "run the tests" or "read a hand-written model" would either
already assume or not surface at all, and "generate interaction sequences" (the
fast-check-frontend approach) would not report as a distinct finding even if it happened
to exercise that code path. `Wizard`'s M3 exploration (docs/m3-exploration-report.md)
found an 8th, unintended state — reaching `step1` with the email field already filled via
the Back button — that the hand-written 6-state model the benchmark's own author wrote
did not anticipate. That is the single clearest demonstration in the whole corpus that
deriving the model finds things a hand-written model misses, which is the entire premise
the tool exists to test.

## Design bets: what paid off, what didn't

**Hook-value state identity — paid off, with one inherent boundary.** Building state
identity from `useState`/`useReducer` values read off the fiber, rather than a DOM hash,
is what made replay-from-root and stable baseline diffing possible at all — a DOM hash
would have made "is this the same state after a CSS class renamed" indistinguishable from
"is this the same state after the component's actual behaviour changed." The boundary is
exactly the one the plan predicted: Context, Redux, and module-level state are invisible
to this mechanism by construction (see README's "Applicability boundary" section), and
the tool cannot detect when it's being pointed at a component whose interesting state
lives outside its own hooks — it will silently under-report, with no warning, which is
the single largest unresolved rough edge in the whole design.

**Adaptive abstraction — paid off relative to M2's static rule, but still needs hand
input more often than the plan hoped.** M2's static bucketing (docs/m2-abstraction-report.md)
needed a per-component override on 5 of 7 benchmark components to hit the intended state
count, three of them full `custom` functions re-encoding business logic. M2.5's dynamic
literal-vs-bucket learning (docs/m2-5-adaptive-report.md) cut that to 1 of 7
(`ValidatedForm`, which needs `custom` for a reason the report states precisely — text
validated by business logic doesn't fit either the "enum" or "free text" bucket the
adaptation can distinguish from observation alone). That's real progress, but "1 of 7
components needs hand-written logic that can silently drift out of sync with the
component it describes" is still a standing gap this PoC never fully closed, and it's the
gap M6's baseline diff inherits directly: a stale `custom` override makes the diff
confidently report "no change" when there was one.

**Replay from root — paid off for correctness, cost the tool wall-clock budget in
return.** It solved the real problem it was chosen for (restoring state via replay rather
than injection means the graph only ever contains states genuinely reachable through the
UI), and the M3.5 report's fix to make replay only observe the final commit (rather than
every intermediate one, which the *first* mount still needs) cut DebouncedSearch's replay
cost by roughly an order of magnitude. The quadratic cost the plan predicted is real and
was measured, not just anticipated: the current default budget (500 actions, 50 states,
30s wall-clock) is comfortably sufficient for every benchmark component, but
DebouncedSearch (docs/m3-exploration-report.md) consumed the entire 30-second default
before this milestone's collapse work made its output legible, and a component with a
genuinely larger or slower-settling state space would hit that ceiling for real.

**Provenance tiers — paid off unambiguously.** `PropGated`'s report is the strongest
single piece of evidence for the whole provenance design: without the `default-props`
vs. `generated-props` distinction, "the component has 4 states" is a true but useless
sentence; with it, "2 of 4 states are only reachable under a wider prop assignment than
your app currently passes, and here's which prop" is directly actionable. This is the one
design bet where the evidence is not mixed.

**Observing every commit — paid off for correctness, cost presentation quality until this
milestone.** Recording every intermediate commit (not just the point where `settle()`
stops) is why the graph correctly distinguishes `waiting` and `searching` as real,
distinct, observable states for `DebouncedSearch` rather than collapsing them invisibly
— but it's also exactly why that component's *pre-M6* report had 18 nodes for what a
human would call 6 states. M6's collapse transform (docs/m6-baseline-report.md) closes
most of that gap for the diagram specifically, without touching the underlying recorded
data — which is the right trade (the JSON artefact keeps every commit; only the picture
changes) but it took a dedicated milestone to build, confirming the M5 report's own
assessment that this was a real, unfinished gap rather than a stylistic nicety.

## Concrete limits a user would hit in practice

- **Point it at a component with Context or Redux state and it will silently under-report,
  with no warning that anything was missed.** This is the largest gap: every other
  limitation in this list at least produces a visible signal (a warning banner, a
  documented column, a "left expanded due to branching" note). This one produces a clean,
  confident, wrong-by-omission report.
- **A component whose text fields are validated by business logic (email format, password
  strength) will not get the "right" state count without a hand-written `custom`
  abstraction override**, and nothing checks that override for staleness against the
  component it describes.
- **A component that debounces, retries, or otherwise produces long async chains will
  still have a large state table**, even after M6's diagram collapse — the collapse fixes
  the diagram, not the underlying row-per-witness table, and two structurally identical
  paths reached by typing different input still produce separate table rows with no
  automatic grouping.
- **A baseline is only as trustworthy as the abstraction config approved alongside it**,
  and a multi-assignment baseline can bake in demotion decisions caused by a single
  degenerate generated prop assignment (M6's Counter example: a random `min`/`max` sample
  wide enough to push `value` past the literal-domain limit) — the diff correctly
  distinguishes that from a real regression, but a developer reading the baseline file
  itself, without running a diff, would see a coarser `value` bucket than they might
  expect and have to understand why.
- **The replay-from-root cost is quadratic and the budget is a hard ceiling**, not a
  graceful degradation — a component past the ceiling gets an "INCOMPLETE RUN" banner and
  a partial graph, not a slower-but-complete one.
- **No browser, no layout, no CSS.** Stated as a non-goal from the start and never
  revisited; genuinely out of scope, not a broken promise.

## What the next three things to build would be

1. **A visible signal for "this component may have external state this tool can't see."**
   Not a full Context/Redux integration (out of scope by design), but a heuristic check —
   e.g. does the component call `useContext` at all, per its source — that turns the
   silent under-report into a stated caveat on the report itself. This is the highest-
   leverage fix available because it's the one gap in the whole PoC that currently fails
   *silently*, and every other limitation at least announces itself.
2. **A staleness check (or at least a fingerprint) for `custom` abstraction overrides.**
   Something as simple as hashing the override function's source and storing that hash in
   the approved baseline, so a diff can at least flag "the override for this component
   changed since this baseline was approved" even without understanding what the override
   does. This directly targets the gap the M2 and M2.5 reports both flagged and M6
   inherited without closing.
3. **Table-level deduplication for transient-chain-inflated components**, extending M6's
   diagram-only collapse into the state table itself — grouping witness rows that differ
   only in which literal input reached a structurally identical state, with the
   individual witnesses still available on expand. This is the concrete next step the M6
   report itself identifies as out of scope for the transform it built.

## Weakest point in the evidence, stated for a skeptical reviewer

The corpus is seven components, and five of the seven needed some form of hand-written
configuration (a `custom` abstraction override, a `fillPools` text pool, an
`invokableProps` map, or a `useFakeTimers` flag) to produce their intended state count at
all. Every milestone report is honest about this component by component, but the
cumulative fact — that "run the tool and get the right answer" was true for the full
pipeline (abstraction through baseline diff) on a minority of the benchmark corpus
without some accompanying hand-written input — is easy to lose sight of reading any
single milestone's report in isolation, and it is the single fact a skeptical reviewer
should weigh most heavily before generalising this PoC's results to an arbitrary
component not in the corpus. The tool's core mechanism (derive-then-review, with
provenance) is demonstrated to work; how often a real-world component needs hand
configuration to make that mechanism produce the *right* graph is not yet answered beyond
"more often than zero," on a corpus that was, by construction (M0), designed to include
the awkward cases rather than average ones.

## Verdict

The core idea — derive a reviewable state model from a component rather than requiring
one as input, and turn that into a regression check via an approved baseline — works, and
the strongest evidence for it is `PropGated`'s provenance-tagged report and `Wizard`'s
discovery of an unintended 8th state neither the hand-written model nor a human skimming
the component was expecting. The mechanism that makes the regression check trustworthy
(state identity stable enough that a refactor doesn't produce spurious diffs) is real and
was tested directly against a component modified on purpose, and the specific failure
mode the plan worried about most for M6 — abstraction churn masquerading as a regression
— was found, reproduced against a real benchmark component's actual generated-props
behaviour, and fixed with a documented, incomplete-by-necessity boundary rather than
papered over. What the PoC does not demonstrate is that this works with *no* hand
configuration on components outside a seven-component corpus explicitly built to include
awkward cases — that claim was never made, but it's the one a reader should be careful
not to infer from a demo that goes well.
