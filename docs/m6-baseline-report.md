# M6 report: transient-chain collapse and baseline approval/diff

This is the capstone milestone: a presentation-layer fix for the collapse problem
docs/m5-report-notes.md left open, plus the approval/diff mechanism docs/poc-plan.md's
M6 section actually specifies. Two independent pieces, covered in order.

## Part 1: collapsing transient async chains

### The transform

`src/report/collapse.ts` is a pure function over an already-recorded graph:
`collapseTransientChains({ states, edges }) -> CollapsedGraph`. It changes nothing about
what the exploration engine records — the full graph, every transient commit included,
still goes into the JSON artefact unchanged (`src/report/json.ts` is untouched by this
milestone). It only changes what `src/report/html.ts` draws as the mermaid diagram.

The rule, per the M6 task brief: a maximal chain `A --user:act--> T1 --auto--> T2 -->
... --> B`, where every `T_i` is transient and `B` is settled, collapses into one edge `A
--act (via T1, T2, ...)--> B`. A transient state only continues the chain if its outgoing
edges all land on the *same* destination — genuine duplicate witnesses of the same auto
transition, which turned out to be common (see "the duplicate-edge bug" below) — and
stops the collapse the moment a transient state has more than one *distinct* outgoing
destination (a real branch). Branch points are reported by name in `branchNotes` and
surfaced in the HTML as a visible list, not silently dropped.

Collapsed states are never deleted. `CollapsedGraph.collapsedStateIds` names them, and
`src/report/html.ts`'s state table lists every state from the full graph with a
"diagram" column reading "collapsed" or "shown," per the M6 requirement that collapsed
intermediates stay visible in the table.

### Wiring

`RenderHtmlOptions.collapseTransientChains` (default `true`) controls the flag on both
`renderExplorationHtml` and `renderMultiAssignmentHtml`. `src/cli.ts` exposes `--expanded`
to turn it off for a given `explore` run; `scripts/explore-runner.test.ts` passes
`collapse: !args.expanded` through. No new artefact type was added — one HTML file,
collapsed by default, with a flag rather than a second file, because the state table
already carries the un-collapsed detail and generating two files for every run felt like
solving a problem the table doesn't have.

### The duplicate-edge bug this transform exposed

The first version of the collapse function used "does this transient state have exactly
one outgoing edge object" as the continuation test. Run against the real
`DebouncedSearch` graph, this collapsed *nothing* — 18 diagram nodes stayed 18. The cause:
the exploration engine records a separate edge object for each witness that observes the
same transition (e.g. two different query strings both produce a `waiting --auto:timer-->
searching` edge with identical `from`/`to`/`driver`), so nearly every transient state in
the real corpus has 2+ outgoing edge *objects* even though they all point at the same
single destination. The fix (now in `collapse.ts`) compares the *set of distinct
destinations*, not the edge count, and only calls it a branch when that set has more than
one member. This is exactly the kind of bug that only shows up against a real graph, not
a hand-built one — the four unit tests in `test/report/collapse.test.ts` cover the clean
chain, a genuine branch, and this duplicate-destination case explicitly so it can't
regress silently.

### Per-component effect

| Component | Before (diagram nodes) | After (diagram nodes) | Collapsed | Left expanded (branch) |
|---|---|---|---|---|
| Toggle | 2 | 2 | 0 | — |
| PropGated | 4 | 4 | 0 | — |
| Counter | 12 | 12 | 0 | — |
| Wizard | 8 | 8 | 0 | — |
| ValidatedForm | 10 | 10 | 0 | — |
| FetchList | 4 | 4 | 0 | 3 chains (the `loading` state genuinely branches to 3 different generated-props outcomes) |
| DebouncedSearch | 18 | **6** | 12 | 0 |

Five of seven components have no transient states at all (or, for FetchList, one
transient state that genuinely branches), so the collapse transform has nothing to do for
them — correctly nothing, not a missed opportunity. DebouncedSearch is the component this
milestone was built for, and it is the only one where the transform does real work.

FetchList's `loading` state is *not* collapsed, and that is the right call, not a
limitation: `loading` is reached once (from `notLoaded` or via `Retry`) and then branches
to three distinct outcomes depending on which generated `fetchItems` assignment is
active. Collapsing "loading, then something" into one edge would erase the actual
branching information a developer needs (the three outcomes are the interesting content
of the graph); the transform's branch rule exists specifically to protect against exactly
this case, and the HTML now names the three branch points explicitly rather than either
force-collapsing them or silently leaving a warning-free diagram that happens to still
show all three edges (which is what would have shipped without the "left expanded"
reporting).

### Is DebouncedSearch reviewable now?

**Yes**, with one honest caveat.

The diagram collapsed from 18 nodes (12 transient) to 6 — `idle`, `waiting-then-searching
gone`, and the three outcome states (`error`, `no-results`, `results`) reached from
`idle` and cross-linked to each other, each edge now reading e.g. `fill 'Search' with
'errorterm' (via s1, s2)`. That is very close to the hand-written model's 6 states (idle,
waiting, searching, results, empty, error) — the diagram no longer forces a developer to
mentally filter out two-thirds of the nodes before finding the states that matter, which
was M5's exact complaint.

The caveat: the *state table* is unchanged by this milestone — it still lists all 18 rows
(now with a "diagram: collapsed" flag on 12 of them), and the duplicated-witness problem
M5 flagged (three structurally identical 9-state chains reached by typing different
terms) is still visible there if a developer scrolls past the diagram into the table. For
a diagram-first review, DebouncedSearch is now genuinely reviewable in a few minutes. For
a developer who also wants to audit the table row by row, the 18-row table is still
there, doing exactly the honest job it always did (nothing is deleted, everything has a
witness) but not itself simplified by this milestone — collapsing rows in the table would
require deciding they're "the same" for table purposes too, which risks hiding real
distinctions (different query strings really are different literal inputs) the M6 task
brief didn't ask this milestone to resolve. The concrete, honest answer: **the diagram
problem M5 identified is fixed; the table-row-duplication problem M5 also mentioned is
not, and wasn't in scope for this milestone's transform (a presentation transform over
*edges*, not a dedup pass over *witnesses*).**

## Part 2: baseline approval and diff

### Schema

`src/baseline/types.ts` defines `Baseline`: `schemaVersion`, `component`, `generatedAt`,
`abstractionConfig` (the demoted/pruned hook sets and `literalDomainLimit` in force at
approval time — a baseline is meaningless without this, per the task brief), a sorted
list of `BaselineState` (a cross-run-stable `key`, a developer-editable `name`,
`provenance`, `transient`, and the raw `fields` snapshot), and a sorted list of
`BaselineTransition` (`from`/`to` by baseline key, `kind`, action or driver, `provenance`,
`stable`).

State identity cannot be the engine's internal `StateId` ("s0", "s1", ...) — those are
assigned in first-observation order within one `exploreComponent` call and are not stable
run to run, a problem `src/props/explore.ts` already solved once for merging
multi-assignment runs within a single invocation via a raw-field `contentKey`. A baseline
needs the same idea but robust to the abstraction rules themselves changing between the
approval run and a later diff run, which raw-field comparison is not (two runs with
different demotion decisions can produce different raw representative field values for
what is conceptually "the same" state). The key used here,
`computeStateKeyForFields` (new export in `src/abstraction/adaptive.ts`, factored out of
the class's private `computeKey`), takes a fields object and an explicit
demoted/pruned/ignored rule set and recomputes the canonicalisation independent of any
particular run's history. This is the one piece of machinery the whole rekey/demotion
handling below depends on.

### `approve` and `diff`

Both are subcommands on the existing `src/cli.ts` (`npm run explore -- approve ...` /
`npm run explore -- diff ...`), reusing the same jsdom-via-Vitest architecture the
existing `explore` command already established (see README's "Known constraint" section)
— `scripts/explore-runner.test.ts` gained a `command` field and dispatches to
`buildBaseline` or `diffAgainstBaseline` (`src/baseline/build.ts`, `src/baseline/diff.ts`)
instead of writing the JSON/HTML report. State names are auto-generated from sorted field
values (e.g. `value=3`, or `initial` for the no-field mount state) with de-duplication
suffixes, exactly so renaming them by hand — the actual approval act, per the task brief —
starts from something legible rather than raw hashes.

`diff` exits non-zero when real differences are found: `scripts/explore-runner.test.ts`
asserts `report.hasDifferences === false` inside the Vitest test the CLI spawns, so a
failing assertion fails the Vitest run, and `src/cli.ts` already propagates the spawned
process's exit code as its own (`process.exit(main())`). A clean diff is a passing test,
exit 0; a real difference is a failing test, non-zero — this is the same mechanism that
makes the tool CI-usable without any bespoke exit-code plumbing.

### Rekey/demotion vs. regression: the core correctness requirement

The scenario the task brief calls out: exploration crosses a hook's
`literalDomainLimit` (or newly qualifies a hook for DOM-correlation pruning) mid-run,
retroactively merging what were until then distinct state ids (`AdaptiveAbstraction`'s
`onRekey`, `src/abstraction/adaptive.ts`). If a baseline was approved under a different
set of demoted/pruned hooks than a later diff run settles on, states that were distinct
at approval time can legitimately not exist anymore under the later run's rules — not
because the component changed, but because the abstraction now groups them together.
Reporting that as N lost states would be exactly the spurious-diff failure mode that
would make the whole tool useless, and the task brief is explicit that this is the single
most important correctness requirement of this milestone.

The fix (`src/baseline/diff.ts`, `diffAgainstBaseline`): recompute every baseline state's
key using `computeStateKeyForFields` under the **current** run's `demotedHooks` /
`prunedHooks` (both newly exposed on `ExplorationResult`, sourced from
`AdaptiveAbstraction.getDemotedHooks()`/`getPrunedHooks()`, and unioned across
multi-assignment runs in `src/props/explore.ts`'s `mergeGraphs`). If two or more baseline
states recompute to the same key, that group is reported as an `abstractionChurnMerge` —
named, with the specific demoted/pruned hooks quoted as evidence — and explicitly
excluded from `lostStates`. A baseline state only counts as genuinely lost if, after this
recompute, its key matches *no* current state at all.

This was verified against a real benchmark component's actual CLI output, not just a
synthetic test. Running `diff` for `Counter` (whose multi-assignment exploration samples
`min`/`max` at random, and some of those generated assignments produce a wide enough
`value` domain across the merged graph to demote `value` past `literalDomainLimit`)
produces:

```
Diff report for Counter:
  new states: 0
  lost states: 0
  abstraction churn merges (NOT regressions): 2
    - value=-4 + value=-98 + value=-87 + value=-1 -> value="negative": these 4 baseline
      states now compute to the same state key under the current run's abstraction rules
      (demoted hooks: [value], pruned hooks: [none]) -- reported as abstraction churn,
      not a regression.
    - value=94 + value=66 + value=1 + value=2 + value=3 + value=4 + value=5 ->
      value="positive": these 7 baseline states now compute to the same state key ...
  new transitions: 0
  lost transitions: 0
  provenance changes: 0
  stability changes: 0
  hasDifferences: false
```

exit code 0. Without the churn/regression distinction, this would have surfaced as 11
lost states on a component that had not changed at all between the two runs — this is not
a hypothetical the demotion-handling code was built to satisfy in the abstract; it is
what `Counter`'s actual merged multi-assignment baseline does every time, because a
random `min`/`max` sample wide enough to push `value` past 8 distinct values is common at
`--sample-count 5` (see docs/m4-props-report.md's Counter section for the same
degenerate-assignment behaviour observed independently at M4).

### A second, subtler bug this surfaced: representative-selection ambiguity

Building the demotion test initially produced a *different* false positive: not a lost
state, but a spurious **provenance change**. When several baseline states collapse onto
one recomputed key, comparing "the" baseline state's provenance against "the" current
state's provenance requires picking one representative from each merged group — and the
first version of `diffAgainstBaseline` picked by array/iteration order, which is not
guaranteed to correspond to the same original state on both sides. In the `Counter` run
above, this showed up as `value=94 (value="positive"): generated-props -> default-props`
— a real diff, but a meaningless one: it was comparing an arbitrary member of a 7-state
merged group against an arbitrary member of the same (or a related) merged group, not two
runs' opinions about the same actual state.

The fix: `provenanceChanges`, `stabilityChanges`, `newTransitions`, and `lostTransitions`
all now explicitly exclude any key involved in an `abstractionChurnMerge` (see
`churnedKeys` / `touchesChurn` in `src/baseline/diff.ts`). This is documented in the code,
not silently patched: comparing a representative of a churned group is not a meaningful
comparison, so those comparisons are dropped rather than reported as either "changed" or
"unchanged" — an unchanged report there would be just as misleading as a changed one,
since neither claim is actually being tested once the identity has become ambiguous.

### Documented limits (the honest part)

This detection is not airtight, and the code comments in `src/baseline/diff.ts` say so
directly:

- **A baseline state's `fields` is one representative snapshot, not the full set of raw
  values that may have already been folded into it at approval time.** If the baseline
  run's own demotion had already merged several literal values into one state before
  approval (the same mechanism, one level earlier), the diff can only reason about the
  one snapshot it kept — it cannot reconstruct which other literal values also fed into
  that baseline state. A demotion that happens differently before approval and again
  differently after it, on a component with three or more raw values feeding one bucket,
  is not fully reconstructible from the baseline file alone. This mirrors a limit already
  present in the exploration engine itself (`src/explore/engine.ts`'s `onRekey` handler
  keeps one representative field set per merged `StateNode`, not a union) — M6 inherits
  this rather than introducing a new instance of it.
- **`buildBaseline` does not know about `ignoreHooks`** used by a run's `AdaptiveOptions`
  unless the caller passes the same value explicitly to `buildBaseline`'s options; the CLI
  wiring does not currently thread a component-specific `ignoreHooks` list through to
  `approve`. None of the seven benchmark components use `ignoreHooks`, so this gap is
  untested and undemonstrated rather than proven safe.
- **Transitions and states that touch a churned key are dropped from the diff entirely**,
  not reported as "unchanged" — which is the conservative, honest choice, but it does mean
  a real regression that happens to land on a churned state (e.g. a new dead-end transition
  added to a state that later gets demotion-merged with three others) could be silently
  excluded from the report rather than flagged. This has not been observed in the
  benchmark corpus but is a real gap the code comments call out rather than hide.

## Tests

Three new tests in `test/baseline/approve-diff.test.tsx`, run against the real
`benchmarks/counter/Counter.tsx` component (not a synthetic graph):

1. **Re-running unchanged produces a clean diff.** `exploreComponent` is run twice under
   identical props against the real Counter, a baseline built from the first run, and
   `diffAgainstBaseline` asserted to report zero of everything (`hasDifferences: false`).
   This is the single most important test in the milestone per the task brief, and it
   passes.
2. **A deliberate behaviour change is caught, and only that change.** `test/fixtures/
   counter-modified/Counter.tsx` is a copy of the benchmark component (never the original)
   that (a) adds a new "Ping" button reusing the existing `value` hook with a sentinel
   `-1` to reach a genuinely new terminal state, and (b) blocks `increment` at `value ===
   3`. The second change turned out to have a real cascading effect worth stating plainly:
   because `decrement` never increases `value`, blocking `increment` at 3 makes `value=4`
   and `value=5` entirely unreachable, not just the single `3->4` transition — the diff
   correctly reports both as lost states, which is the right outcome for what is actually
   a bigger regression than the fixture's own doc comment first claimed before this was
   discovered by running the test. The final assertions: exactly one new state
   (`value="lit:-1"`), exactly `value=4`/`value=5` lost, an `increment`-labelled lost
   transition, and zero provenance or stability changes.
3. **A forced demotion is reported as abstraction churn, not lost states.** Two
   `exploreComponent` calls against the same unmodified Counter, differing only in
   `abstraction.literalDomainLimit` (default 8 vs. forced 2) so the second run demotes
   `value`. Asserts `lostStates` is empty and `abstractionChurnMerges` contains a group
   with more than one baseline state.

Four unit tests in `test/report/collapse.test.ts` for the collapse transform against
hand-built graphs (clean chain, genuine branch, the duplicate-destination case that broke
the first implementation, deterministic re-invocation, and the no-op case of a user edge
landing directly on a settled state).

Full suite, run after all M6 changes:

```
 Test Files  29 passed | 1 skipped (30)
      Tests  137 passed | 1 skipped (138)
   Start at  10:22:46
   Duration  7.17s (transform 511ms, setup 1.46s, collect 7.09s, tests 20.70s, environment 9.18s, prepare 1.27s)
```

`npm run typecheck` passes with no output (strict mode, no errors). The one skipped test
is `scripts/explore-runner.test.ts`'s CLI driver test, correctly skipped outside a real
CLI invocation — the same pre-existing, documented skip from M5, unrelated to this
milestone.

## Baselines checked in

`examples/baselines/*.baseline.json` — one per benchmark component, generated by the real
`approve` CLI subcommand (`npm run explore -- approve --component ... --export ...
--config examples/configs/*.config.ts --sample-count 5 --vary-per-prop 2 --seed 2`,
matching the parameters already used for `examples/*.json`/`*.html`), not hand-written.
Each was independently verified to produce a clean `diff` (`hasDifferences: false`, exit
0) via the real CLI immediately after being approved.

## Files changed

New:
- `src/report/collapse.ts` — the collapse transform (Part 1).
- `src/baseline/types.ts`, `src/baseline/build.ts`, `src/baseline/diff.ts` — baseline
  schema, `approve`, and `diff` logic (Part 2).
- `test/report/collapse.test.ts`, `test/baseline/approve-diff.test.tsx` — new tests.
- `test/fixtures/counter-modified/Counter.tsx` — deliberate-change fixture (a copy, not an
  edit, of the benchmark component).
- `examples/baselines/*.baseline.json` — checked-in baselines for all seven benchmark
  components.

Modified (all minimal, each with an inline comment explaining why):
- `src/report/html.ts` — wires the collapse transform into diagram rendering behind a
  default-on `collapseTransientChains` option; adds a "diagram" column to the state table.
- `src/cli.ts` — adds `explore`/`approve`/`diff` subcommand dispatch and the `--expanded`
  flag; existing no-subcommand invocations still default to `explore` (backwards
  compatible).
- `scripts/explore-runner.test.ts` — dispatches on `command` to write the JSON/HTML report,
  build and write a baseline, or diff against one.
- `src/abstraction/adaptive.ts` — factors the private `computeKey` into an exported
  `computeStateKeyForFields`, and adds `getPrunedHooks()` alongside the existing
  `getDemotedHooks()`. Both are needed by `src/baseline/diff.ts` to recompute a baseline
  state's key under a later run's abstraction rules.
- `src/explore/graph.ts`, `src/explore/engine.ts` — adds `demotedHooks`/`prunedHooks` to
  `ExplorationResult`, sourced from the two new `AdaptiveAbstraction` getters.
- `src/props/explore.ts` — unions `demotedHooks`/`prunedHooks` across all assignment runs
  when merging a multi-assignment result, matching how `domPruneReport` was already
  merged.
- `src/report/json.ts` — serialises the two new `ExplorationResult` fields (sorted, for
  determinism, matching the file's existing convention).
