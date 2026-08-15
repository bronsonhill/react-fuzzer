# M2 report: state abstraction

This is the exit-criterion writeup for M2. For each benchmark component it gives the
state count from the hand-written machine, the state count the abstraction produces
under the default rules (booleans verbatim, strings to empty/nonEmpty, numbers to a
sign-and-zero bucket, collections to empty/one/many), the count with whatever override
the component needed, which override that was, and an account of every remaining
mismatch. All numbers below come from running `test/abstraction/corpus.test.tsx`
against the actual components — not from working the abstraction out on paper — and
that test file is the artefact that should be re-run to check this table stays true.

## Summary table

| Component | Expected states | Default rules | With overrides | Override needed |
|---|---|---|---|---|
| Toggle | 2 | 2 | — | none |
| Counter | 3 | 2 | 3 | `custom`: min/mid/max bucketing aware of the clamp bounds |
| PropGated (mode=simple) | 2 | 2 | — | none |
| PropGated (mode=advanced) | 4 | 4 | — | none |
| Wizard | 6 | 4 | 6 | `custom`: keep `step` verbatim (small numeric union) |
| ValidatedForm | 10 | 5 | 10 | `custom`: email/password classified `empty`/`invalid`/`valid` by business rule |
| FetchList | 4 | >2, wrong shape | 4 | `literalHooks: ["status"]`, `ignoreHooks: ["attempt"]` |
| DebouncedSearch | 6 | <6 | 6 | `literalHooks: ["phase"]` |

Two of seven components (Toggle, PropGated) match the hand-written machine under the
default rules with no per-component configuration. The other five all needed an
override, and for three of them (Counter, Wizard, ValidatedForm) the override had to be
a full `custom` function — `literalHooks` was not enough.

## Per-component account

### Toggle — no mismatch

A single boolean (`on`). The default rule keeps booleans verbatim, so `on: false` and
`on: true` map directly onto the two expected states. Nothing to report.

### Counter — default rule cannot see the clamp bounds

The hand-written machine wants three states: `min`, `mid`, `max`. `Counter`'s only hook
is `value`, a plain number, and under default props `value` never goes negative (`min`
defaults to 0). The sign-and-zero bucket only has `zero` and `positive` to work with, so
every value from 1 through 5 collapses into the same `positive` token — the abstraction
cannot distinguish "at max" (5) from "any other positive value" (1–4), because "at max"
is a fact about the relationship between `value` and the `max` prop, not a fact
recoverable from `value` in isolation. The default rule produces 2 states where 3 are
expected.

The fix used here is a `custom` override that reads the raw hook value and buckets it
against hard-coded min/max bounds matching the component's default props:

```ts
custom: (snapshot) => {
  const value = snapshot.hooks.find((h) => h.kind === "state")!.value as number;
  const bucket = value <= 0 ? "min" : value >= 5 ? "max" : "mid";
  return { key: `value=${bucket}`, fields: { value: bucket } };
}
```

This recovers exactly 3 states. It is a genuine limitation of the plan's number-bucketing
rule as specified (sign-and-zero), not a bug in the implementation: sign-and-zero is a
property of one value, and "at a prop-derived bound" is a property of two. A more general
fix would let `AbstractionOptions` see the component's *props*, not just its hooks — the
current `custom` signature only receives the `ComponentSnapshot` (hooks), so recovering
this required hard-coding the bounds into the override rather than deriving them, which
means the override itself would go stale if `Counter`'s default `min`/`max` changed. This
is worth revisiting before M4, since M4 generates multiple prop assignments and a
hard-coded-bound override cannot follow them.

### PropGated — no mismatch, and the phantom-state risk is empirically absent

Two booleans (`notificationsOn`, `expertModeOn`), both kept verbatim by the default rule.
Under `mode="simple"` the abstraction produces exactly 2 states (matching the 2
`simple_*` states in the expected machine); under `mode="advanced"` it produces exactly
4 (matching all 4 `advanced_*` states).

The interesting check here was whether `expertModeOn` — a hook that exists in the fiber
under `mode="simple"` but has no button to toggle it in that mode — would inflate the
simple-mode count. It does not, and the test confirms this empirically rather than
assuming it: `expertModeOn` stays `false` for the whole `mode="simple"` interaction
sequence, so it contributes the constant token `false` to every observed state and never
creates a second value to fork on. A hook that never changes value cannot multiply the
state count under hook-value identity, by construction — canonicalisation only produces
extra states when a field actually takes on more than one value across the observed
commits.

### Wizard — default rule collapses two pairs of states via a numeric discriminant

`step` (1/2/3), `name`, `email` (strings), `done` (boolean). The hand-written machine
wants 6 states. Under the default rule, `step` is a number and gets the sign-and-zero
bucket like `Counter`'s `value` — all three step values are positive, so `step`
contributes the same constant token everywhere and carries no information. That leaves
`name`/`email` empty-or-nonEmpty and `done` to do all the work, and two genuinely
distinct states collide as a result:

- `step1-filled` (`name=nonEmpty, email=empty`) and `step2-empty` (`name=nonEmpty,
  email=empty`) produce the same key.
- `step2-filled` (`name=nonEmpty, email=nonEmpty`) and `step3` (`name=nonEmpty,
  email=nonEmpty`) produce the same key.

The default rule produces 4 states (`step1-empty`, the `step1-filled`/`step2-empty`
merge, the `step2-filled`/`step3` merge, `done`) where 6 are expected.

This is a case the plan's `literalHooks` escape hatch does not cover, because
`literalHooks` is specified as string-preserving and `step` is a number. The fix used
here is a `custom` override that keeps `step` verbatim instead of bucketing it:

```ts
custom: (snapshot) => {
  const [step, name, email, done] = /* hooks in declared order */;
  if (done) return { key: "done", fields: { done: true } };
  return {
    key: `step=${step}|name=${name ? "nonEmpty" : "empty"}|email=${email ? "nonEmpty" : "empty"}`,
    fields: { step, name: ..., email: ... },
  };
}
```

This recovers exactly 6 states. The general lesson: any small discrete numeric union used
as a phase/step discriminant (not just strings) needs literal-style preservation, and the
plan's `literalHooks` as specified doesn't reach it. A reasonable extension for later
milestones would be a `literalHooks` that isn't string-typed — e.g. a per-hook
`identityMode: "bucket" | "literal"` that works for any primitive — rather than requiring
a full `custom` function every time a numeric enum shows up.

### ValidatedForm — default rule under-counts by more than a factor of 2

`email`, `password` (strings), `submitted` (boolean). The hand-written machine wants 10
states: a 3×3 cross product of `{empty, invalid, valid}` for each field, plus
`submitted`. The default rule only has `{empty, nonEmpty}` for strings, so `invalid` and
`valid` collapse into the same `nonEmpty` token; the abstraction produces 5 states
(2×2 + 1) instead of 10.

This case also can't be fixed with `literalHooks`, for a different reason than `Wizard`:
`literalHooks` preserves the string verbatim, but `email` and `password` don't take
values from a small fixed literal set — they're free text, and what actually matters is
which of three classes (empty / fails validation / passes validation) the text falls
into. That classification depends on the component's own validation logic (a regex for
email, a length check for password), so it has to be expressed as a `custom` function
that reimplements those rules:

```ts
custom: (snapshot) => {
  const classify = (v: string, valid: (s: string) => boolean) =>
    v.length === 0 ? "empty" : valid(v) ? "valid" : "invalid";
  // ...
}
```

This recovers exactly 10 states. The honest cost here is that the override duplicates
the component's validation logic (the email regex, the `>= 8` length check) inside the
test/abstraction configuration; if the component's validation rule changes, the override
has to change with it, and nothing enforces that they stay in sync. That's an inherent
property of state abstraction for validation-shaped components, not a defect specific to
this implementation — the abstraction can't infer "what counts as valid" from the hook
value alone, only from the developer telling it.

### FetchList — default rule under-counts and over-counts in different places at once

`status` (string: `loading`/`error`/`empty`/`loaded`), `items` (array), `attempt`
(number, an internal retry counter never rendered). The hand-written machine wants 4
states, one per `status` value, explicitly folding "first load" and "reload after Retry"
into a single `loading` state (see the expected machine's notes).

Under the default rule, `status`'s four values all bucket to the constant `nonEmpty`
token, so `status` alone can't distinguish `loading`/`error`/`empty`. `items` (empty vs.
non-empty) picks up some of the slack — `loaded` is distinguishable because `items` is
non-empty there and empty everywhere else — but `loading`, `error`, and `empty` all share
`items=empty` and collapse together. At the same time, `attempt` (also a plain number,
also sign-and-zero bucketed) is `zero` on first mount and `positive` after any Retry
click, so it silently *splits* the `loading` state that the expected machine says should
be single: "loading, first visit" and "loading, after Retry" get different keys purely
because of an internal counter that never renders anything. The net effect measured by
the corpus test is a state count greater than 2 (from `attempt` splitting `loading`) but
still not the correct 4 (because `status` isn't distinguishing `loading`/`error`/`empty`)
— the default rule is wrong in two directions simultaneously, which is a good illustration
of why "run against the corpus" rather than "reason about the rule in the abstract" is
the actual exit criterion.

The fix is two separate overrides addressing two separate problems:
`literalHooks: ["status"]` (a string-literal union, exactly the case the plan calls out)
recovers the `loading`/`error`/`empty`/`loaded` split, and `ignoreHooks: ["attempt"]`
removes the phantom split of `loading` into two variants. Together they produce exactly
the expected 4 states. `attempt` is a genuinely new finding not called out in the plan's
description of `literalHooks`: bookkeeping state that exists in the fiber, is never
rendered, and should be excluded from identity entirely — the plan anticipated
`ignoreHooks` existing but the corpus is what surfaced a concrete case that needs it.

### DebouncedSearch — the plan's own worked example, confirmed empirically

`text`, `phase` (string literal union: `idle`/`waiting`/`searching`/`results`/
`no-results`/`error`), `results` (array). The hand-written machine wants 6 states, one
per `phase` value. Under the default rule `phase`'s values are all non-empty strings and
collapse to the constant `nonEmpty` token, exactly as the plan predicted; the corpus test
confirms the default-rule state count is strictly less than 6 (specifically, `idle` is
distinguishable via `text=empty`, but `waiting`/`searching`/`no-results`/`error` all
share `text=nonEmpty, results=empty` and collapse together, and `results` only splits
off when there's actually a non-empty results array). `literalHooks: ["phase"]` recovers
exactly 6.

Unlike `Wizard`'s `step`, `phase` is a string, so this is squarely the case
`literalHooks` was designed for and it works as specified with no extra machinery.

## Stability claim

Tested in `test/abstraction/stability.test.tsx` with two synthetic fixture components
(not part of the benchmark corpus, so nothing there was modified): `StabilityV1`
declares `useState` for `count` then `flag`; `StabilityV2` declares `flag` first, then
inserts an unrelated `extra` hook, then `count` — simulating a benign reorder plus an
added unrelated feature, the exact scenario the plan's M2 section calls out as the reason
name-based addressing exists. With `sourcePath` supplied (enabling ts-morph naming) and
`extra` in `ignoreHooks`, driving both components to the same logical state (`count=1,
flag=true`) produces byte-identical `StateKey.key` values across V1 and V2, despite the
different hook order and the inserted hook.

A second test confirms the honesty requirement in the spec: when the ts-morph-derived
hook list disagrees with the runtime hook list (here, forced by pointing `sourcePath` at
a source file with only one hook while the rendered component actually has two), the
abstraction falls back to index-based naming (`hook0`, `hook1`, ...) and records a
warning, rather than silently mis-mapping a name to the wrong hook.

The claim holds for the case tested — a reorder plus an insertion, both non-conditional.
It has not been tested against a hook made conditional (`if (flag) useState(...)`),
which is invalid React and out of scope, or against a hook whose *type* changes across a
refactor (a `useState` hook replaced by a `useReducer` doing the same job) — that case is
exactly what the kind-order disagreement check catches and falls back on, so it is
"safe" in the sense of not lying, but it does not preserve identity across that
particular refactor; it just declines to guess.

## Is M6 (baseline diffing) viable on this evidence

Cautiously yes, with one caveat. The stability test is the direct predicate for M6's
premise — "a refactor does not produce a page of spurious diffs" — and it holds for the
concrete case tested (reorder + insertion). The caveat is that five of seven benchmark
components needed a per-component override to hit the correct state count at all, and
three of those overrides are full `custom` functions that re-encode business logic
(validation rules, clamp bounds) rather than generic bucketing. That means a baseline
diff is only as trustworthy as the override configuration checked in alongside it: if a
developer changes `ValidatedForm`'s password rule from `length >= 8` to `length >= 10`
without updating the corresponding `custom` override, the abstraction will silently keep
using the stale rule and the baseline diff will report no change when there actually is
one. This isn't a flaw in the stability mechanism itself, but it is a real gap between
"state identity is stable" and "state identity is correct" that M6 will inherit, and the
override configuration should probably live next to the component it describes (rather
than in a test file, as it does here) so a change to one is more likely to prompt a
change to the other.

## Known limitation carried over from src/fiber and src/settle

Neither module needed changes for M2; both were used as-is (`extractSnapshot`,
`onCommit`, `settle`). No fix was required or made there.
