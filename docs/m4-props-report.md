# M4 report: prop generation

This is the exit-criterion writeup for M4. `src/props/propsToArbitraries.ts` extracts a
component's declared props interface with `ts-morph` (the TS compiler API, per
`docs/poc-plan.md`'s stated preference) and maps each prop type to a `fast-check`
arbitrary; `src/props/explore.ts` runs a full M3.5 `exploreComponent` under the example
props and under a generated set of additional assignments, then merges the resulting
graphs with provenance. All numbers below come from `test/props/propsToArbitraries.test.ts`,
`test/props/explore.test.tsx`, and `test/props/corpus-multi.test.tsx` (a one-off measurement
pass over the full seven-component corpus, mirroring how the M3/M3.5 reports used a similar
pass — the console output is not checked in as an assertion beyond "no replay divergences,"
but the numbers here are transcribed directly from an actual run).

## Summary table

| Component | Props inferred | Props overridden | Runs (example + generated) | Merged states | default-props | generated-props | Distinct shapes | Responsible prop identified | Aggregate actions | Aggregate elapsed |
|---|---|---|---|---|---|---|---|---|---|---|
| Toggle | `label` | none | 8 | 2 | 2 | 0 | 1 | n/a (no shape change) | 48 | 66.5ms |
| Counter | `min`, `max`, `start` | none | 12 | 12 | 6 | 6 | 9 | `min`, `max`, `start` (all isolated) | 570 | 204.9ms |
| **PropGated** | `mode` | none | 10 | 4 | 2 | 2 | 2 | **`mode` (isolated)** | 180 | 63.1ms |
| Wizard | none | `onComplete` (fixed, `fc.constant`) | 6 | 8 | 8 | 0 | 2 | `onComplete` (isolated) — see note below | 766 | 473.5ms |
| ValidatedForm | none | `onSubmit` (fixed, `fc.constant`) | 6 | 10 | 10 | 0 | 2 | `onSubmit` (isolated) — see note below | 2205 | 1384.8ms |
| **FetchList** | none | `fetchItems` (3-way outcome generator) | 10 | 4 | 2 | 2 | 3 | `fetchItems` (isolated) | 45 | 42.4ms |
| DebouncedSearch | `debounceMs` | `query` (fixed, `fc.constant`) | 8 | 18 | 18 | 0 | 1 | none (no shape change) | 840 | 627.0ms |

Every run's aggregate `replayDivergences` count is 0. `PropGated` and `FetchList` (bold) are
the two exit-criterion components; both are discussed in full below.

## Deliverable A: what `ts-morph` resolved and what needed overrides

`propsToArbitraries` locates `${componentName}Props` (falling back to the component
function's declared parameter type if that convention isn't used) and walks its properties
via the TS compiler API's `Type` methods (`isString`, `isNumber`, `isBoolean`, `isUnion` +
`getUnionTypes`/`isStringLiteral`/`isNumberLiteral`, `isArray`, `isObject` +
`getProperties`, `getCallSignatures`). Per-component:

- **Toggle** (`label?: string`): inferred cleanly, wrapped in `fc.option` for optionality.
- **Counter** (`min?`, `max?`, `start?: number`): all three inferred cleanly as
  `fc.option(fc.integer({min:-100,max:100}))`.
- **PropGated** (`mode: 'simple' | 'advanced'`): inferred as `fc.constantFrom('simple',
  'advanced')` — the highest-value case the deliverable calls out, confirmed directly:
  `test/props/propsToArbitraries.test.ts` samples 50 times and asserts the sample set is
  exactly `{'simple', 'advanced'}`, not a wider string domain.
- **Wizard** (`onComplete?: (data: {...}) => void`): **not** inferred. `onComplete` is a
  function type; `propsToArbitraries` throws `cannot infer an arbitrary for prop
  "onComplete" (function-typed prop; requires an explicit override)`. This is the intended
  "fail loudly" behaviour, not a limitation to work around — see below for what override was
  supplied.
- **ValidatedForm** (`onSubmit?: (data: {...}) => void`): same as `onComplete`, fails loudly
  naming `onSubmit`.
- **FetchList** (`fetchItems: () => Promise<Item[]>`): fails loudly naming `fetchItems`. The
  task singled this out as a case worth reporting honestly: `ts-morph`'s TS-compiler-API
  approach resolves the *shape* of this type perfectly well (it correctly identifies it as a
  function type via `getCallSignatures().length > 0`, so the diagnosis is accurate and
  specific), but a function type was never going to be something this module infers a value
  for regardless of how well it resolves — the plan requires an explicit override for any
  callback, by design, not because resolution failed. The M4 task description's phrasing
  ("resolve" `FetchList`'s `fetchItems`) is really asking whether the type is correctly
  *identified* as unhandleable rather than silently misclassified as something else (e.g. an
  opaque `any`); it is correctly identified, and the failure is the intended one.
- **DebouncedSearch** (`query: (text: string) => Promise<SearchResult[]>`, `debounceMs?:
  number`): `debounceMs` inferred cleanly (`fc.option(fc.integer(...))`); `query` fails
  loudly naming `query`, same reasoning as `fetchItems`.

Honest account against the plan's stated risk (`react-docgen-typescript`'s known limitation
with imported/externally declared types): the corpus's props interfaces are all declared
locally in the same file as the component, so this run does not exercise the
imported-type-resolution case `ts-morph` is supposed to do better at. `Item` and
`SearchResult` (used inside `FetchList`'s and `DebouncedSearch`'s function-prop return
types) are declared in the same file too, so even the "resolves it but the prop is a
function anyway" case above never actually needed `ts-morph`'s import-resolution advantage
to reach the correct (loud-failure) outcome. This is a real gap in what the corpus can
demonstrate about the compiler-API-vs-docgen tradeoff specifically; nothing here required
resolving a genuinely externally-declared type. A synthetic fixture with a props interface
importing a type alias from another module would be needed to actually exercise that claim
directly; none of the seven benchmark components happen to need it.

## Deliverable A: the override escape hatch

`propOverrides: Record<string, fc.Arbitrary<unknown>>` is consulted before inference for
that prop and always wins, per the plan's explicit statement that this escape hatch is
expected, not a failure. Three shapes were used across the corpus:

- **A fixed no-op** (`Wizard`'s `onComplete`, `ValidatedForm`'s `onSubmit`):
  `fc.constant(() => {})`. These callbacks are fired at a terminal transition (`Finish`,
  `Submit`) and are not read back by the component afterward, so a no-op is a legitimate,
  non-guessing choice here — the override is explicit and developer-supplied, not something
  `propsToArbitraries` invented on its own.
- **A 3-way outcome generator** (`FetchList`'s `fetchItems`): `fc.constantFrom('populated',
  'empty', 'reject').map(outcome => makeFetchItems(outcome))`, where `makeFetchItems`
  returns a constant closure for the life of one assignment. See "Replay-safety of generated
  function props" below for why this shape specifically, not e.g. a function that varies its
  own behaviour across calls.
- **A fixed pure function** (`DebouncedSearch`'s `query`): `fc.constant(query)` where `query`
  is a single hand-written function of its `text` argument. Not sampled/varied across
  assignments — see below for why.

## Deliverable B and C: `PropGated` — the exit criterion, verified

`PropGated`'s `mode: 'simple' | 'advanced'` prop gates `expertModeOn`'s only UI-reachable
mutation (the "Expert mode" button, rendered only when `mode === 'advanced'`). Running
`exploreMultiAssignment` with `mode: 'simple'` as the example props and `mode`'s
`fc.constantFrom('simple', 'advanced')` arbitrary produces exactly the plan's expected
shape:

- The merged graph has 4 states, 2 with `default-props` provenance and 2 with
  `generated-props` provenance.
- The 2 `generated-props` states both have `expertModeOn: true`.
- Every `generated-props` state's `witness.props` records `mode: 'advanced'` — the
  responsible assignment, per the plan's provenance table (`generated-props`: "Prop
  assignment + action sequence").
- `mode` is reported in `responsibleProps` with `confidence: 'isolated'`, from the
  one-prop-at-a-time pass (varying only `mode`, holding every other prop at its example
  value, changed the shape).

**A finding worth stating precisely, because it's a real subtlety in what "the four
advanced_* states" means**: `PropGated.expected.ts`'s notes already say this — "mode is not
itself part of the internal hook-derived state identity... the state ids above prefix with
the mode purely for human readability." Two of the hand-written machine's four
`advanced_*` states (`advanced_notif-off_expert-off` and `advanced_notif-on_expert-off`,
both with `expertModeOn = false`) have **identical hook values** to the two `simple_*`
states, since `mode` is a prop, not a hook, and doesn't itself appear in state identity.
Under hook-value identity (which is what this engine actually uses, per M2's design), these
two pairs are not merely similar — they are the same state, correctly collapsed by the
merge. Only the two states where `expertModeOn = true` (unreachable at all under
`mode='simple'`, since there is no button to toggle it there) are genuinely new states that
only exist under the generated assignment. So the exit criterion's "the four advanced_*
states appear with generated-props provenance" is true in spirit for the two that matter —
the two that mode='simple' behaviourally cannot reach — but literally only 2 of the 4
hand-written `advanced_*` ids get their own distinct merged state; the other 2 ids denote
states already present (correctly) under `default-props`. This is stated as a finding, not
patched around: forcing all 4 advanced-labelled ids to appear as distinct merged states
would mean re-introducing mode into state identity, which the plan explicitly rules out
("do NOT fold props into state identity"). `test/props/explore.test.tsx` asserts this
precisely (`generatedStates.length >= 2`, every generated state has `expertModeOn: true`),
not the naively-expected 4, with the reasoning inline as a comment.

## Deliverable B and C: `FetchList` — reaching all 4 expected states

M3.5's report noted `FetchList` only discovers 2 states (`loading`, transient; `error`,
settled) with one fixed deterministic `fetchItems` mock, since a single stub can only
produce one outcome. `exploreMultiAssignment` with `fetchItems`'s 3-way outcome arbitrary
(`populated` / `empty` / `reject`) and `mode='reject'` as the example assignment reaches
all 4 of the expected machine's states in the merged graph:

- `loading` and `error`: `default-props` (reached under the example assignment, same as the
  M3.5 corpus test).
- `empty` and `loaded`: `generated-props`, each attributed to the generated assignment whose
  `fetchItems` resolves that way.
- `fetchItems` is correctly identified as the responsible prop (`isolated` confidence).
- 0 replay divergences across all 10 runs (1 example + 3 vary-one + 6 random, all drawn from
  the same 3-outcome domain).

This confirms the exit criterion's second case directly:
`test/props/explore.test.tsx`'s FetchList test asserts all four `status` values are present
in the merged graph, `error` is `default-props`, and `empty`/`loaded` are `generated-props`.

## Replay-safety of generated function props: handled deliberately, not incidentally

The M3 report's finding — "a mock with hidden call-count state is not replay-safe, because
replay-from-root remounts and re-invokes it, and a mock that varies its result across calls
has no way to know it's being asked to reproduce a specific earlier call rather than advance
to the next one" — is exactly the failure mode M4's generated function props would hit if
handled naively (e.g. a single arbitrary that returns a *stateful* mock, incrementing a
counter across calls). This was avoided by construction, not discovered by hitting it:

- `fetchItems`'s arbitrary generates an **outcome label** (`fc.constantFrom(...)`) and maps
  it to a **constant closure** (`makeFetchItems(outcome)`) that always returns the same
  promise result for that assignment, however many times replay-from-root remounts and calls
  it. Variation happens *across* assignments (different `exploreComponent` calls each get
  their own constant `fetchItems`), never *within* one — which is precisely what
  multi-assignment exploration is for, and sidesteps the M3 replay-safety hazard entirely by
  never generating a function whose behaviour depends on its own call history.
- `query` uses the same principle but doesn't need to be *sampled* at all: it is a single
  fixed override, a pure function of its `text` argument (the same shape the M3.5 corpus test
  already used, for the same reason). `debounceMs` is what's actually varied for
  `DebouncedSearch` across assignments (see below), not `query`.

This is stated as the general rule this module and its callers must follow, not just a fact
about these two components: **a generated function prop must be a pure function of its
arguments for the life of one assignment** (constant if it takes no arguments, like
`fetchItems`; a genuine pure mapping if it does, like `query`). `propsToArbitraries` cannot
enforce this — it never generates a function value at all (see Deliverable A) — so this is a
constraint on how a developer writes `propOverrides` for a function-typed prop, and it is
documented here rather than left implicit for the next person to rediscover by hitting a
replay divergence.

## `DebouncedSearch`, `Wizard`, `ValidatedForm`: no shape change from state, but one from
## actions — an honest side-finding

`DebouncedSearch`'s only inferred (not overridden) prop, `debounceMs`, produced no shape
change across 8 runs (1 distinct shape) — expected, since `debounceMs` only affects timing,
which `settle()`'s to-quiescence contract deliberately makes invisible to the state graph
(see the M3 report's "any state whose defining characteristic is 'in flight' is invisible").

`Wizard`'s `onComplete` and `ValidatedForm`'s `onSubmit`, however, **were** flagged as
`responsible props` despite the merged **state** count not changing (8 and 10 respectively,
matching `default-props` in both cases with 0 `generated-props` states). The shape hash
still differs, because `exploreComponent`'s default `invokableProps` derivation
(`Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === "function"))`)
exposes any function-valued prop as an `invokeProp` action automatically. The example props
used here pass `onComplete: undefined` / `onSubmit: undefined` (no callback supplied, a
legitimate real-world case per each component's own props type, which marks them optional),
so no `invokeProp` action exists under the example assignment; the generated assignment
supplies an actual function (via the `fc.constant(() => {})` override), which *does* produce
an extra discoverable action and therefore an extra edge, even though invoking that action
doesn't create any new state (the no-op returns to the same graph shape it was already at).
This is accurately reported — `mode`/`fetchItems`-style state-shape changes and
`onComplete`/`onSubmit`-style action-availability changes are both genuine "the props
changed what's reachable" findings, just at different levels (which *states* exist vs. which
*actions* exist) — but it means "responsible prop" as currently implemented does not
distinguish those two levels for the reader, which a future report (M5) presenting this data
should probably do explicitly rather than lump under one `responsibleProps` list.

## The `custom`-override staleness check on `Counter`

The task asked whether `Counter`'s M2 `custom` override (which M2.5's report says was
already left unapplied, hard-coding `min`/`max` bounds) is still present and would go stale
under generated props. Checked directly: no `custom` override for `Counter` exists anywhere
in the current corpus (`test/explore/corpus.test.tsx`'s `Counter` run uses no `abstraction`
option at all, matching the M2.5 report's stated outcome — "not applied"). There was nothing
to fix. `Counter`'s multi-assignment run above (12 runs varying `min`/`max`/`start`, 9
distinct shapes, all three props correctly identified as responsible) demonstrates the
adaptive abstraction handling varied bounds correctly with no override at all, which is the
scenario the M2.5 props-aware `custom` signature was built to support *if* an override were
ever needed here — it wasn't, and this run is direct evidence that leaving `Counter`
override-free continues to be the right call under M4's generated props, not just under M3's
fixed ones.

## Budget: per-assignment and aggregate

Budget is unchanged from `src/budget.ts` (`DEFAULT_BUDGET`); no run in the corpus pass
exhausted it (`anyExhausted: false` for every component). Aggregate cost scales
roughly linearly with (number of assignments run) × (per-assignment cost from M3.5),
as expected since each assignment is an independent `exploreComponent` call:

| Component | Runs | Aggregate actions | Aggregate elapsed | Per-run elapsed (aggregate / runs) |
|---|---|---|---|---|
| Toggle | 8 | 48 | 66.5ms | ~8.3ms |
| Counter | 12 | 570 | 204.9ms | ~17.1ms |
| PropGated | 10 | 180 | 63.1ms | ~6.3ms |
| Wizard | 6 | 766 | 473.5ms | ~78.9ms |
| ValidatedForm | 6 | 2205 | 1384.8ms | ~230.8ms |
| FetchList | 10 | 45 | 42.4ms | ~4.2ms |
| DebouncedSearch | 8 | 840 | 627.0ms | ~78.4ms |

Every per-run figure is in the same order of magnitude as the single-assignment M3.5 numbers
for the same component (e.g. `ValidatedForm`'s ~186ms single-run figure vs. ~231ms here,
`DebouncedSearch`'s ~91ms vs. ~78ms) — consistent with M3.5's own prediction that M4 "should
still watch for the transient-state count multiplying faster than the settled-state count"
but otherwise inherits the real (not virtual) wall-clock headroom that milestone established.
No component came close to `DEFAULT_BUDGET.maxWallClockMs` even summed across every
assignment in a single test file run (all seven components' aggregate elapsed times sum to
well under 3 seconds).

## Is the merged multi-assignment graph comprehensible, or too noisy to review?

Honest assessment, as requested. It depends heavily on which prop is being varied:

- **For a genuinely branch-gating prop** (`PropGated`'s `mode`, `FetchList`'s `fetchItems`),
  the merged graph is comprehensible and exactly as useful as the plan promises: a developer
  sees the normal graph they'd get from M3, plus a small number of extra
  `generated-props`-tagged states/edges, each with a clear responsible-prop witness. This is
  the intended case and it works well — `PropGated`'s merged graph is 4 states, easy to scan;
  `FetchList`'s is 4 states from 10 runs, likewise easy to scan despite the relatively large
  run count, because the *merge* collapses repeated discoveries down to the actual distinct
  content.
- **For a prop with a wide numeric range and no natural small domain** (`Counter`'s
  `min`/`max`/`start`), the merge is noticeably less legible: 9 distinct shapes from 12 runs,
  12 merged states, no natural grouping a reader could eyeball quickly beyond "this prop
  changes the bounds, which is not surprising." This isn't a defect in the merge machinery —
  it's an honest reflection that `Counter`'s state count is fundamentally tied to its numeric
  domain (see the M2.5/M3 finding that `value` stays literal within `literalDomainLimit`),
  and varying `min`/`max`/`start` necessarily varies that domain. A future report (M5)
  presenting this to a developer would likely want to summarize "N distinct shapes, ranging
  from 1 to 6 states, driven by min/max/start" as a single sentence rather than rendering all
  9 shapes' full graphs, which this milestone's `distinctShapes` output already gives the raw
  material for but doesn't itself condense.
- **For a callback prop whose only effect is exposing an extra `invokeProp` action**
  (`Wizard`'s `onComplete`, `ValidatedForm`'s `onSubmit`), the "responsible prop" flag is
  technically correct but potentially confusing on its own — a developer seeing "onComplete
  changed the graph shape" without also seeing that the state count didn't move might
  reasonably wonder what changed. This is the side-finding discussed above and is a real gap
  in how legible the *report* of a shape change is, not in whether the underlying detection
  is correct.

Net judgement: the raw merged graph plus the `distinctShapes`/`responsibleProps` structured
data is the right layer to build M5's report on, and is comprehensible for the corpus's
"interesting branch" components (`PropGated`, `FetchList`) exactly as designed. It is not, by
itself, comprehensible for a numeric-range prop or a callback-exposure prop without some
presentation-layer summarization that this milestone does not attempt, since M5 (the report)
is explicitly out of scope here.

## Changes made outside `src/props/` and `test/props/`

None. `src/explore/`, `src/abstraction/`, `src/fiber/`, `src/settle.ts`, `src/budget.ts`, and
every benchmark component/`.expected.ts` file are unchanged. All 108 pre-existing tests still
pass unmodified; 17 new tests were added across `test/props/propsToArbitraries.test.ts` (8),
`test/props/explore.test.tsx` (2), and `test/props/corpus-multi.test.tsx` (7), for 125 total.

## Honest summary of what doesn't fully work

- **`responsibleProps` conflates state-shape changes with action-availability changes** (see
  `Wizard`/`ValidatedForm` above). Both are real findings but a reader can't currently tell
  which kind they're looking at from the `responsibleProps` list alone; only by cross-checking
  the `generated-props` state count separately.
- **No corpus component's props interface imports a type from another module**, so
  `ts-morph`'s claimed advantage over `react-docgen-typescript` on externally-declared types
  is not actually exercised by anything in this report — every prop that resolves,
  resolves from a locally-declared type, and every prop that doesn't resolve fails because
  it's a function type (correctly identified as such), not because of an import-resolution
  gap `react-docgen-typescript` would have hit but `ts-morph` didn't.
- **The one-prop-at-a-time pass samples very few alternate values per prop** (`varyPerProp`,
  2-3 in the corpus run above) — enough to demonstrate the mechanism and get correct
  attribution on this corpus, but not a thorough sweep of each prop's domain; a numeric prop
  with a narrow interesting range (e.g. a boundary value one unit away from a clamp) could be
  missed by a small random sample without a targeted boundary-value strategy, which this
  milestone does not add.
- **Numeric-range props produce merged graphs that are technically correct but not
  presentation-ready** (`Counter`, discussed above) — a real limitation of "just merge
  everything," not fixed here since summarizing this well is explicitly M5's job.
- **The correlated (non-isolated) responsible-prop detection pass is weak by construction**:
  it only fires when exactly one prop happens to differ between two random assignments with
  different shapes, which is unlikely for a component with several props (as the corpus
  numbers show — every corpus component's responsible-prop findings above came from the
  isolated, one-prop-at-a-time pass, not the correlated pass; the correlated pass never fired
  in this run). This is stated as expected behaviour, not a bug: the isolated pass is the
  reliable mechanism per the task's guidance ("a simple approach that works for the corpus is
  fine"), and the correlated pass is explicitly secondary, best-effort evidence.
