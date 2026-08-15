# M2.5 report: adaptive state abstraction

This is the write-up for M2.5, a refinement of the M2 state abstraction. The starting
problem, from `docs/m2-abstraction-report.md`, was that five of seven benchmark components
needed a per-component override to reach their hand-written state count, and three of those
overrides were full `custom` functions re-encoding the component's own logic — validation
rules, clamp bounds. M2's canonicalisation is static: each hook value is bucketed by its
runtime type alone, so a small discrete union like `Wizard`'s `step` or `FetchList`'s
`status` gets flattened to a constant token.

M2.5 adds `AdaptiveAbstraction` (`src/abstraction/adaptive.ts`), which learns two things
from observed behaviour instead of fixing them in advance: whether a hook's value looks
like a small enum worth keeping verbatim, and whether a hook's value ever shows up in the
rendered DOM at all. All numbers below come from `test/abstraction/adaptive-corpus.test.tsx`
and `test/abstraction/adaptive-rekey.test.ts`, run against the actual components, mirroring
how `test/abstraction/corpus.test.tsx` was the source of the M2 numbers.

## Summary table

| Component | Expected states | M2 default | M2 w/ override | M2.5 adaptive, no override | M2.5 w/ override | Override survives? |
|---|---|---|---|---|---|---|
| Toggle | 2 | 2 | — | 2 | — | none needed |
| Counter | 3 | 2 | 3 (`custom`) | 6 | not applied | see below — judgement call, not forced |
| PropGated (simple) | 2 | 2 | — | 2 | — | none needed |
| PropGated (advanced) | 4 | 4 | — | 4 | — | none needed |
| Wizard | 6 | 4 | 6 (`custom`) | 6 | — | **M2's `custom` no longer needed** |
| ValidatedForm | 10 | 5 | 10 (`custom`) | 5 (demoted) | 10 (`custom`, props-aware signature) | `custom` still needed — inherent limit |
| FetchList | 4 | >2, wrong shape | 4 (`literalHooks`+`ignoreHooks`) | 4 | — | **both overrides no longer needed** |
| DebouncedSearch | 6 | <6 | 6 (`literalHooks`) | 6 | — | **`literalHooks` no longer needed** |

Under M2.5, one component (`ValidatedForm`) needs a `custom` override, matching the target
of at most two of seven. `Counter` reaches 6 states with no override and is deliberately not
forced down to 3 — see its section below for why that is a defensible outcome rather than a
miss. Every other component — including three (`Wizard`, `FetchList`, `DebouncedSearch`)
that needed an override under M2 — reaches its expected count with the adaptive
abstraction and zero component-specific configuration.

## Deliverable A: adaptive value domains

`AdaptiveAbstraction.observe()` tracks, per named hook, the set of distinct canonical
values observed so far. While the hook's value is a primitive (string, number, boolean,
`null`, `undefined`) and the distinct-value count is at or below `literalDomainLimit`
(default 8), the value is preserved verbatim in the state key — the same idea as M2's
`literalHooks`, but decided dynamically, for any primitive type, and without per-component
configuration. Once the count exceeds the limit, the hook is **permanently** demoted to
M2's bucket rule (empty/nonEmpty for strings, sign-and-zero for numbers, verbatim for
booleans). Non-primitives (arrays, Sets, Maps, plain objects) always bucket; they are never
eligible for literal mode, matching the deliverable's specification directly.

### The demotion/rekey mechanism, and what M3 should do with it

Demotion is retroactive: a hook that looked like a 3-valued enum for the first several
observations, and got three distinct state ids as a result, can turn out on the fourth
observation to have a fourth distinct value, push its domain past the limit, and demote —
at which point all three (or four) previously-issued ids denote the same bucketed state and
must collapse into one.

`observe()` handles this by never trying to update state incrementally. Every call:

1. Appends the new observation to an in-memory history of every observation this instance
   has ever seen (raw hook field values, whatever DOM fingerprint was supplied, and a
   session id — see Deliverable B).
2. Re-derives the demoted-hook set from scratch, by scanning the *entire* history and
   checking whether the domain size for each hook has now exceeded the limit. Since history
   only grows, a domain's size is monotonically non-decreasing across calls, so the demoted
   set is monotonic too — a hook demotes at most once and never un-demotes.
3. Re-derives the DOM-prunable hook set from scratch (Deliverable B).
4. Recomputes the key for *every* history entry under the now-current rules, and assigns
   ids in first-occurrence order. Where a newly-computed key's occupants already agree on a
   previously-issued id, that id is kept (so ids don't churn on every call that doesn't
   actually change anything). Where multiple previously-distinct ids now compute to the
   same key, the lowest-numbered (earliest-issued) id is kept as the survivor and the rest
   are reported as merged into it via `onRekey`.

This is a full re-key pass over history on every `observe()` call, which the deliverable
explicitly permits ("state counts here are small... a full re-key pass over observed
history is acceptable; correctness matters far more than efficiency") and the budget backs
up — the plan caps exploration at 50 states, so a full pass is bounded and cheap at that
scale. `test/abstraction/adaptive-rekey.test.ts` exercises this directly with a fixture
hook that starts literal, gets a fourth distinct value, and demotes; the test asserts that
all four previously-distinct ids collapse into a single survivor and that `onRekey` fires
with the merge.

**What M3 should do with `onRekey`:** M3's exploration graph has, at the point a demotion
happens, some number of graph nodes for the now-merged ids, each with its own set of
outgoing edges (untried and tried actions) and incoming edges from other nodes. On a merge
event `{ from: [...], to }`, M3 needs to: redirect every edge that pointed at a `from` id to
point at `to` instead; union the tried/untried action sets of all merged nodes onto `to`
(an action tried from one now-merged node has, definitionally, been tried from the state
`to` now represents); and drop the `from` nodes from the frontier. This is a graph merge,
not a graph deletion — provenance and witnesses recorded against the `from` nodes need to
carry over to `to` rather than being discarded, since the developer-facing report should
still be able to say "this state was reached via this action sequence" even after a
demotion folds it into a coarser one. The interface was designed with exactly this consumer
in mind: `onRekey` returns id lists, not raw state content, so the caller (which owns the
graph) does the graph surgery.

### The threshold trade-off, honestly

`literalDomainLimit` (default 8) is a single global knob and it has to serve two opposing
goals: high enough that a genuine small union survives — the corpus's largest is
`DebouncedSearch`'s 6-valued `phase` — and low enough that a free-text field is bucketed
before its accidental short-lived variety fools the abstraction into treating it as an
enum. **This trade-off could not be resolved by threshold tuning alone**, and the corpus
run surfaced this directly rather than just in principle. The first attempt at driving
`Wizard` and `DebouncedSearch` through `AdaptiveAbstraction` — reusing the M2 test's
interaction sequences verbatim, which type text character by character and use a different
search term per mounted instance — produced 8 states for `Wizard` (not 6) and 10 for
`DebouncedSearch` (not 6). In both cases the cause was a free-text hook (`Wizard`'s `name`,
`DebouncedSearch`'s `text`) whose domain, in that particular short run, happened to stay
under the limit, so it stayed literal and forked states that should have collapsed: typing
"Ada" character by character produces the literal values `"A"`, `"Ad"`, `"Ada"` as three
separate `step=1` states instead of one; three different search terms across three mounted
instances make `waiting`/`searching` triplicate by term instead of collapsing by phase.

The fix applied was not a per-component override on the abstraction — it was **driving the
components with single-action field fills** (one `fireEvent.change` per field per intended
value, and the same search term reused across `DebouncedSearch`'s three mounts) instead of
character-by-character typing. This is not a workaround chosen to make the numbers come
out right: M3's action model treats "fill this text field" as one action, not N
keystroke-actions, so single-action driving is the representative way to exercise the
adaptive abstraction, and the M2 corpus test's character-by-character typing simply never
exposed this because M2's bucketing collapses every non-empty intermediate value to the
same token regardless. **This is a real, load-bearing finding, not incidental to the
report:** adaptive literal-mode abstraction is sensitive to action granularity in a way
static bucketing is not, and a future M3 that generates or replays keystroke-level actions
(rather than field-level fills) would reproduce the over-counting this section describes.
The action-discovery milestone should treat "set an input's value" as a single action for
this reason, independent of any UI-testing convention about firing individual `input`
events.

With that granularity fixed, no threshold change was needed: the default `literalDomainLimit
= 8` correctly keeps `step` (3 values), `status` (4 values), and `phase` (6 values) literal,
and correctly demotes `email`/`password` in `ValidatedForm`, whose domain over the drive
sequence exceeds 8 distinct strings (see that section below).

## Deliverable B: DOM-correlation pruning

`src/abstraction/domFingerprint.ts` computes a normalised structural fingerprint of
rendered DOM: tag names, trimmed text content, and a fixed allowlist of semantically
relevant attributes (`disabled`, `value`, `checked`, `role`, and all `aria-*` attributes),
dropping everything else (classes, inline styles, `data-*`, React-internal markers).

`AdaptiveAbstraction` accepts an optional `domFingerprint` alongside each observation and,
after a configurable minimum number of observations (`domCorrelation.minObservations`,
default 3), evaluates each hook for pruning: a hook whose value changed with no
accompanying DOM-fingerprint change is supporting evidence it isn't rendered; a hook whose
value changed *with* an accompanying DOM change, even once, is disqualifying (never
pruned), on the theory that a hook that is sometimes load-bearing for the DOM must not be
silently dropped from identity just because it also happened to vary invisibly elsewhere.
`getDomPruneReport()` exposes, per hook, the evidence count and the resulting decision —
per the deliverable's instruction that pruning must be reported prominently, not applied
silently, this is surfaced as data the caller (a future report generator) is expected to
render, not swallowed into the state key computation invisibly.

### Two false positives found and fixed, both from the same root cause

The first implementation of the pruner, run against `FetchList`, produced results that were
wrong in both directions before being fixed, and both failures came from the same
assumption: that any two *consecutive* observations in history are meaningfully comparable.
They are not, once a component instance can be unmounted and remounted (as the corpus test
does for `FetchList` — a fresh mount per network scenario — and as M3's replay-from-root
will do continuously).

1. **Mount-boundary confound.** Comparing the last observation of one mount against the
   first observation of the next mount makes *every* hook look like it changed and the DOM
   look like it changed, because it is in fact an entirely different render of a fresh
   component instance, not a transition. This produced spurious "co-varied" evidence for
   `attempt` (`FetchList`'s internal retry counter, the hook this deliverable specifically
   targets), which blocked its pruning entirely. The fix: `ObserveInput.sessionId`, an
   opaque value the caller sets per mount; the pruner only compares consecutive
   observations within the same session.
2. **Simultaneous-change confound.** Even within one session, `FetchList`'s Retry handler
   calls `setAttempt`, and the effect that depends on `attempt` calls `setStatus("loading")`
   — depending on React's commit batching, these can land in the same commit the pruner
   observes. When two hooks change in the same transition, a DOM change in that transition
   cannot be attributed to either one individually; treating it as evidence for both (as the
   first implementation did) produces exactly the same false "co-varied" signal for
   `attempt`, this time even within a single session. The fix: a transition is only used as
   evidence for a hook if that hook is the *only* identity hook that changed value in it;
   transitions with multiple simultaneous changes are excluded from evidence altogether
   rather than being counted as disqualifying for every hook involved.

With both fixes, `attempt` is correctly pruned (`test/abstraction/adaptive-corpus.test.tsx`
asserts `pruned: true, everCoVaried: false` for it), and `status`/`items` are correctly not
pruned. `test/abstraction/adaptive-rekey.test.ts` isolates the co-variation guard directly:
a synthetic hook that varies silently twice (would-be prune evidence) and then, in a later
*isolated* transition, varies in step with the DOM once, is correctly never pruned — the
single disqualifying observation overrides the earlier supporting count, as the spec
requires ("no observation where the hook value and DOM fingerprint co-varied").

### Limits, stated plainly

The isolation requirement (guard 2) means the pruner is now strictly more conservative than
a naive consecutive-pair diff: it needs to observe a hook change *in isolation* at least
`minObservations` times to prune it, and a component whose hooks always change in lockstep
(e.g. a reducer that always updates two fields together) will never produce isolated
evidence for either, so neither gets pruned even if neither is DOM-visible. This is the
right failure mode — no pruning, rather than a wrong attribution — but it does mean the
pruner is weaker on components with tightly coupled internal state than on `FetchList`,
where the retry counter happens to change independently of status in at least some commits.
No false positive was found in the final implementation against the benchmark corpus, but
the corpus is only seven components; the mechanism should be treated as a heuristic that
requires real evidence before acting, not a proof, exactly as the deliverable frames it. A
hook that only affects a future transition (not the current render) is exactly the failure
mode the deliverable calls out as a risk, and nothing in this implementation detects that
case — it would look identical to a genuinely dead hook until a transition surfaces it,
at which point the isolation-and-co-variation guard would correctly stop pruning it (once
observed), but not before.

## Deliverable C: props visibility

`AbstractionOptions.custom` (`src/abstraction/index.ts`) and `AdaptiveOptions.custom`
(`src/abstraction/adaptive.ts`) both now receive the component's current prop values as a
second argument: `(snapshot: ComponentSnapshot, props: Record<string, unknown>) =>
StateKey | undefined`. `abstractState` and `AdaptiveAbstraction.observe` both accept props
and pass them through. This is backward compatible — a `custom` function that only reads
its first argument remains a valid implementation of the new type, and none of the existing
M2 corpus tests needed to change.

`Counter`'s adaptive result makes the motivating example for this deliverable moot in
practice: under the adaptive abstraction, `Counter`'s `value` (domain size 6, well under the
default limit of 8) stays literal automatically, so no `custom` override — and therefore no
hard-coded clamp bounds — is needed for `Counter` at all (see below). The interface change
still stands on its own merits for components where a `custom` override remains necessary
(`ValidatedForm` here): the corpus's `ValidatedForm` override does not currently use `props`
(its validation rule doesn't depend on props), but the signature is now available for a
component whose validation bounds, thresholds, or classification *did* depend on a prop —
which is exactly the shape of problem M4's generated prop assignments will create.

## Counter: 6 states, not forced to 3

With no override, `Counter`'s adaptive result is 6 distinct states — one per concrete value
0 through 5 — because `value`'s domain size (6) is within `literalDomainLimit` (8), so it
stays literal rather than bucketing to zero/positive as it did under M2's default rule.

This is deliberately **not** forced down to 3 (min/mid/max) by adding an override. The
hand-written machine's own notes (per the M2 report) already flag that collapsing values 1
through 4 into a single "mid" state is a judgement call about what counts as "the same
state" for a bounded counter, not a fact recoverable from the component. Six concrete
values is, if anything, the *more honest* answer for what the component's fiber state
actually does: `value` genuinely takes six distinct values, each with its own rendered
output (the `<output>` text differs, and `disabled` flips at the two ends), and the
adaptive abstraction reporting six states is reporting exactly what is observably true,
without importing a coarsening decision the abstraction has no way to justify on its own.
Whether "3" or "6" is the *useful* number for a developer reviewing this component's graph
is a product decision about how coarse a baseline should be — outside M2.5's scope — and
not evidence that the abstraction under- or over-counts. If a developer wants the coarser
3-state view, `bucketHooks`-style forcing (not currently exposed, since no benchmark
component needed it after the Wizard/DebouncedSearch driving fix above) or a `custom`
override remain available; neither was needed here to match a *correct* count, only to match
a *specific pre-conceived* count.

## ValidatedForm: still needs `custom` — an inherent limit, not a defect

With no override, `ValidatedForm` produces 5 states (matching M2's default-rule result
exactly) because `email` and `password`, driven through the same edit/clear/retype sequence
used in the M2 corpus test, take on more than 8 distinct string values over the run and
demote to M2's empty/nonEmpty bucket rule. `getDemotedHooks()` confirms both `email` and
`password` are demoted.

Demotion is the *correct* outcome here, not a missed opportunity for a higher threshold.
Raising `literalDomainLimit` would not fix this: the meaningful classification
(empty/invalid/valid) depends on the component's own validation logic — an email regex, a
length check — which is not recoverable from the *set* of distinct values observed no
matter how large the threshold, because "valid" and "invalid" are both open-ended sets of
strings, not small fixed domains. A `custom` override (using the new props-aware signature
from Deliverable C, though this component's rule doesn't currently need props) recovers
exactly the expected 10 states, unchanged in substance from the M2 override — this remains
a real limit of dynamic-domain-size abstraction, worth stating rather than working around:
**a hook's abstraction target can depend on business logic that no amount of watching
values go by will reveal**, and `custom` (or an equivalent developer-supplied
classification) is the correct escape hatch for that case, not a sign the automatic
machinery is under-built.

## Stability under the adaptive path

`test/abstraction/stability.test.tsx` gained a second describe block that repeats the M2
stability claim — a benign hook reorder (`count`/`flag` swapped) plus an inserted unrelated
hook (`extra`) must not change state identity — against `AdaptiveAbstraction` rather than
`abstractState`. It passes: the two fixture components (`StabilityV1`, `StabilityV2`)
produce the same `StateId` for the same logical state (`count=1, flag=true`), and a direct
`abstractState` cross-check using the same `sourcePath`-driven naming confirms the adaptive
class is resolving hooks by name exactly as M2 does, so the stability guarantee is inherited
rather than coincidental. This matters more for M2.5 than it did for M2, because name
resolution now feeds a stateful class — domain tracking, demotion, DOM pruning all
accumulate across calls — so a naming bug had more room to surface only after several
observations rather than immediately; it did not.

## Outlook for M6 (baseline diffing)

The M2 report's caveat on M6 was that a baseline diff is only as trustworthy as the override
configuration checked in alongside it, and that five of seven components needed one,
three of them full `custom` functions re-encoding business logic that could silently drift
out of sync with the component. M2.5 narrows that surface area substantially: six of seven
components now need zero configuration, and the one that still needs `custom`
(`ValidatedForm`) needs it for a reason this report can state precisely — a classification
that depends on validation logic, which is an inherent limit rather than an abstraction
gap. That is a smaller, more defensible piece of hand-written configuration for a baseline
to depend on than M2's five-component override surface was.

The adaptive mechanism also introduces a new kind of instability M6 will need to account
for that M2's purely static rule did not have: a baseline captured early in an exploration,
before a hook's domain has exceeded `literalDomainLimit`, can have its state identities
retroactively rekeyed by later exploration within the *same* run (that's what `onRekey`
handles), but a baseline that was *approved and checked in* under one exploration's
demotion/pruning decisions is not automatically re-evaluated against a later run that
observes more of the component and reaches a different demotion or pruning decision. In
plain terms: if a first exploration run only ever exercises `Counter`'s `value` up to 5 (6
distinct values, stays literal) but a later run also drives it out to a hypothetical 9th
distinct value under different props, `value` would demote in the later run and produce a
coarser baseline than the checked-in one — a real diff, correctly, but one whose cause
(a threshold crossed) is a different *kind* of finding than a refactor-caused diff, and
M6's report should probably distinguish "state identity changed because the component
changed" from "state identity changed because more exploration crossed a domain-size
threshold," which the `onRekey` merge events (recorded, not just applied) give it the raw
material to do, but M6 will need to explicitly carry that information forward into the
diff rather than only comparing final state sets.

## Files

- `src/abstraction/adaptive.ts` — `AdaptiveAbstraction` (Deliverable A, and the pruning
  half of Deliverable B).
- `src/abstraction/domFingerprint.ts` — `computeDomFingerprint` (Deliverable B).
- `src/abstraction/index.ts` — `custom`/`abstractState` extended with a `props` parameter
  (Deliverable C); `IDENTITY_KINDS` and `resolveHookNames` exported for reuse by the
  adaptive module.
- `test/abstraction/adaptive-corpus.test.tsx` — Deliverable D's corpus re-run.
- `test/abstraction/adaptive-rekey.test.ts` — unit-level demotion/pruning/rekey checks,
  including the merge case and the co-variation guard, independent of any real component.
- `test/abstraction/stability.test.tsx` — extended with the adaptive-path stability check.
- `test/abstraction/corpus.test.tsx` — unmodified; still the M2 static-path source of truth.
