# react-fuzzer

A tool that takes a React component, explores it by generating props and driving
interactions, and produces a state graph: the distinct states the component can be in
and the transitions between them. The developer reviews the graph and decides whether
it's the one they intended. See `docs/poc-plan.md` for the full design plan this
implementation follows; this README summarises what's built, how to run it, and — more
importantly — when it will and won't tell you anything useful.

## What it does

Given a React component, react-fuzzer:

1. Generates prop assignments for the component's declared props (using `ts-morph` to
   read the TypeScript interface and `fast-check` to generate values), plus runs the
   developer-supplied "example" props.
2. Mounts the component in jsdom under each assignment and drives it through every
   discoverable interaction (clicks, fills, selects, invoking function props) via a
   depth-first search, replaying from a fresh mount to backtrack.
3. Identifies states by the component's own `useState`/`useReducer` hook values (read
   via React DevTools' commit hook, not by hashing the DOM), abstracted into a small
   state key so that, e.g., a number field becomes "empty/one/many" rather than one
   state per literal value — but the abstraction *adapts*: if a hook's actual observed
   values look like a small enum it's kept verbatim instead of bucketed.
4. Merges the per-assignment graphs into one, tagging every state and edge with
   *provenance*: whether it was reached under the example props (`default-props`) or
   only under a generated assignment (`generated-props`).
5. Produces a JSON artefact (the durable, versioned record) and a self-contained HTML
   report (a Mermaid diagram, a state table with witnesses, findings, prop analysis,
   and budget usage) for a human to review.

## Core design decisions

**Fuzz props, reach state.** Props come from outside the component, so any value
satisfying the declared type is something a parent could legally pass — generating
props is sound. Internal state is produced by the component's own logic and is only
ever *reached* by mounting and interacting with it, never written directly into the
fiber. See docs/poc-plan.md's "Fuzz props, reach state" for the full argument.

**Provenance, not a reachability boolean.** Every state and edge records *how* it was
obtained, with a witness (the concrete action sequence from mount, plus the prop
assignment for `generated-props` states). A `generated-props` state is real with
respect to the declared prop contract but may not occur in the app as actually used —
the usual actionable reading is "the prop type is wider than actual usage." This is the
single most useful thing the reports surface; see `examples/PropGated.html` for the
clearest demonstration (a `mode` prop that gates an entire internal branch, correctly
tagged `generated-props` and correctly attributed to `mode` in the prop-analysis
section).

**State identity comes from hook values, not the DOM.** `__REACT_DEVTOOLS_GLOBAL_HOOK__`
gives per-commit access to a component's `useState`/`useReducer` values. A state
identity built from those corresponds far more closely to what a developer means by "a
state" than a DOM hash does, and stays far more stable across visual refactoring
(rewording a label, restyling a button). It also means the tool depends on React's
internal fiber shape; see "Fiber instability" below.

**Replay from root for backtracking.** Depth-first exploration returns to a previously
visited state by unmounting, remounting fresh with the same props, and re-executing the
recorded action sequence — not by restoring state directly, which would reintroduce the
unreachability problem and can't restore anything outside the fiber (module-level
variables, timers). This is quadratic in graph size, which is why the engine runs in
jsdom rather than a real browser and why there's an explicit budget (`src/budget.ts`):
500 actions, 50 states, 30 seconds wall-clock per exploration run, by default.

## How to run it

```
npm install
npm test          # 137 passing, 1 skipped — see "Known constraints" below
npm run typecheck
npm run explore -- [explore|approve|diff] --component <path> --export <ExportName> [options]
```

### CLI options

The subcommand defaults to `explore` if omitted (backwards compatible with pre-M6
invocations). `approve` and `diff` are covered in "`approve` and `diff`" below.

```
npm run explore -- \
  --component benchmarks/counter/Counter.tsx \
  --export Counter \
  --config examples/configs/counter.config.ts \
  --sample-count 5 --vary-per-prop 2 --seed 2 \
  --out-json examples/Counter.json --out-html examples/Counter.html
```

| Flag | Meaning |
|---|---|
| `--component <path>` | Required. Path to the component's source module. |
| `--export <name>` | Required. Named export identifying the component function. |
| `--config <path>` | Optional module whose default export configures the run: `{ exampleProps, propOverrides, fillPools, invokableProps, settle, useFakeTimers, single }`. See `examples/configs/*.config.ts` for real examples covering every shape (plain props, function props needing an override, text fields needing a fill pool, fake-timer components). |
| `--out-json`, `--out-html` | Output paths. Default to `examples/<export>.json` / `.html`. |
| `--sample-count`, `--vary-per-prop`, `--seed` | Prop-generation controls, forwarded to `exploreMultiAssignment`. |
| `--max-actions`, `--max-states`, `--max-wall-clock-ms` | Budget overrides. |
| `--single` | Skip prop generation; run once under `exampleProps` only (only `default-props` provenance). |
| `--expanded` | (M6) Disable the default-on transient-async-chain collapse in the HTML diagram; the state table and JSON artefact are always full-fidelity regardless of this flag. See `docs/m6-baseline-report.md`. |

### Known constraint: the CLI runs through Vitest, not bare Node

The exploration engine needs the jsdom environment and
`src/fiber/devtoolsHook.ts`'s `__REACT_DEVTOOLS_GLOBAL_HOOK__` installed *before*
react-dom loads (react-dom checks for the hook exactly once at its own module init).
Reproducing that bootstrapping and import-ordering correctly in bare Node would be
fragile and easy to get subtly wrong. Instead, `src/cli.ts` is a thin argv-parsing
wrapper: it builds a config object and spawns `vitest run scripts/explore-runner.test.ts`
with that config passed through an environment variable, then exits with the child's
exit code. `scripts/explore-runner.test.ts` is where the actual exploration and
file-writing happen, reusing exactly the jsdom/devtools-hook setup every other test in
this repo already relies on (`test/setup.ts`). This is honest rather than a workaround:
`npm run explore` works end to end (verified against all seven benchmark components; see
`examples/`), it just does so by being a Vitest invocation under the hood.

`scripts/explore-runner.test.ts`'s own test is `it.skipIf`'d to a no-op whenever the
config environment variable isn't set — which is every ordinary `npm test` run. That is
the one skipped test in the `129 passed | 1 skipped` total: it is not a failing or slow
test being hidden, it is the CLI's driver test correctly doing nothing when nothing
asked it to run an exploration.

## Applicability boundary — read this before pointing the tool at your component

This section is deliberately concrete, not a gesture at limitations.

- **A fully controlled component produces a single-node graph, correctly.** If every
  piece of a component's rendered output is a pure function of its props (no internal
  `useState`/`useReducer`), there is nothing for the state-identity mechanism to find,
  and the tool will report exactly one state with no transitions. That is the *correct*
  output for such a component, not a failure of the tool — but it also means the tool
  has nothing useful to tell you about a component that's already fully controlled.
- **State in Context or an external store (Redux, Zustand, a module-level cache) is
  invisible.** State identity is built from the *instrumented subtree's* own
  `useState`/`useReducer` hook values, read off the fiber. A component that reads from
  `useContext` or an external store can visibly change behaviour across renders without
  any of that showing up in the state graph, because the mechanism this tool uses to
  detect state literally cannot see it. If your component's interesting behaviour lives
  outside its own hooks, this tool will under-report states, silently, with no warning
  in the output — there is currently no detection for "this component reads external
  state" the way there is for DOM-correlation pruning.
- **`ValidatedForm` needs a custom abstraction override to reach its intended 10 states
  in general.** The state abstraction (`src/abstraction/adaptive.ts`) learns, per hook,
  whether its observed values look like a small enum or free-ranging text. Text fields
  validated by business logic (an email regex, a length check) don't fit either bucket
  cleanly: with no override the adaptive abstraction demotes them and produces only 5
  states (see `docs/m2-5-adaptive-report.md`, "ValidatedForm: still needs `custom` — an
  inherent limit, not a defect"). `examples/ValidatedForm.html`'s 10 states were reached
  without an explicit abstraction override in this run only because the deliberately
  narrow `fillPools` (3 fixed values per field) kept the observed domain small enough to
  stay classified as a literal enum by coincidence, not because the general problem is
  solved — a component fuzzed with less constrained text input would need the `custom`
  override this milestone did not have to write.
- **`DebouncedSearch` inflates from action granularity, and the report doesn't yet
  collapse it.** The hand-written model has 6 states; the generated report has 18 (12
  transient). This isn't a wrong graph — every state is a real, distinct commit the
  component passes through — but typing whole strings in one `fireEvent.change` rather
  than character-by-character, combined with DFS's backtracking revisiting states via
  different paths, splits states that are behaviourally identical into separate nodes
  by how the input was typed to reach them. See `docs/m5-report-notes.md` for the full
  breakdown and what a fix (collapsing transient async chains into one labelled edge)
  would look like; it wasn't built in this milestone.
- **Everything under `src/fiber/` is unpinned React internals.** Fiber shape is not a
  public API and is not guaranteed stable across React versions. This repo pins React
  19.1.0 and isolates all fiber traversal behind `src/fiber/`'s adapter module
  specifically so that a future React upgrade has one place to fix, but an upgrade
  *will* require revisiting that module — there is no compatibility guarantee here.
- **No browser-based exploration, no layout/visual/CSS state.** jsdom has no layout
  engine; anything expressed only in computed style or actual rendered position is
  invisible to this tool, by design (see docs/poc-plan.md's non-goals).

If your component is a pure function of props, or its interesting state lives in
Context/Redux/a module singleton rather than its own hooks, this tool will tell you
"one state, nothing to see" — which is either the right answer or a sign you're
pointing it at the wrong boundary, and there's currently no way for the tool itself to
tell you which.

## Generated example reports

`examples/` holds real generated JSON + HTML for all seven benchmark components (not
hand-written; regenerate with the `npm run explore` invocations recorded in
`examples/configs/*.config.ts`, one config per component). Open the `.html` files
directly in a browser — they are single self-contained files, no server needed:

- `examples/Toggle.html` — trivial baseline, 2 states.
- `examples/PropGated.html` — the clearest demonstration of the provenance mechanism:
  a prop-gated branch correctly surfaced as `generated-props` with the responsible prop
  identified.
- `examples/FetchList.html` — loading/error/empty/loaded, one transient state.
- `examples/Wizard.html` — 8 states, dense diagram; table-first review recommended.
- `examples/ValidatedForm.html` — 10 states, 120 edges; diagram is not usable for
  transition-level review, table only. See the applicability boundary above on why 10
  states here isn't proof the abstraction problem is solved in general.
- `examples/Counter.html` — 12 merged states across generated prop assignments,
  reviewable via the table; see `docs/m5-report-notes.md` for why the diagram needed an
  edge-provenance label (`[gen]`) added during this milestone to avoid being misleading.
- `examples/DebouncedSearch.html` — was 18 states (12 transient) against a hand-written 6,
  the corpus's genuine presentation failure case (`docs/m5-report-notes.md`); as of M6 the
  diagram collapses the 12 transient states into labelled edges, down to 6 diagram nodes.
  See `docs/m6-baseline-report.md`.

`docs/m5-report-notes.md` has the full per-component judgement on report usefulness —
what's reviewable, what isn't, and specifically why (pre-M6 collapse; `docs/m6-baseline
-report.md` covers the effect of the collapse transform component by component).

`examples/baselines/*.baseline.json` holds one checked-in approved baseline per benchmark
component, generated by the real `approve` CLI subcommand (see below) — not hand-written.

## `approve` and `diff`

Beyond generating a report, the CLI can check in an approved baseline and diff a later run
against it:

```
# Write examples/baselines/Counter.baseline.json (developer then renames states by hand)
npm run explore -- approve --component benchmarks/counter/Counter.tsx --export Counter \
  --config examples/configs/counter.config.ts --sample-count 5 --vary-per-prop 2 --seed 2

# Diff a fresh run against it; exits non-zero (CI-usable) if real differences are found
npm run explore -- diff --component benchmarks/counter/Counter.tsx --export Counter \
  --config examples/configs/counter.config.ts --sample-count 5 --vary-per-prop 2 --seed 2
```

`approve` writes a baseline: each state's cross-run-stable key, its provenance, its raw
hook fields, an auto-generated readable name (e.g. `value=3`) meant to be renamed by hand
— renaming states in the checked-in file *is* the approval act — and the abstraction
config (demoted/pruned hooks, `literalDomainLimit`) that produced it, since a baseline is
meaningless without knowing what abstraction produced it.

`diff` reports new states, lost states, new/lost transitions, provenance changes, and
stability changes, and exits non-zero exactly when any of those is non-empty. It also
reports **abstraction churn merges** separately and explicitly not as regressions: if the
abstraction demotes or prunes a hook differently between the baseline run and the diff
run (crossing `literalDomainLimit`, or a DOM-correlation pruning decision changing), some
baseline states can legitimately collapse together under the new rules without the
component itself having changed at all — reporting that as "N lost states" would make the
tool useless as a regression check. See `docs/m6-baseline-report.md` for how this
distinction is made, verified against a real benchmark component's actual output, and
where it remains genuinely ambiguous (documented, not hidden).

`--component`/`--export`/`--config` and the prop-generation/budget flags work identically
across `explore`, `approve`, and `diff`. `diff` additionally takes `--baseline <path>`
(default `examples/baselines/<export>.baseline.json`).

## Milestone documentation

- `docs/poc-plan.md` — the design plan (read this first).
- `docs/m2-abstraction-report.md`, `docs/m2-5-adaptive-report.md` — state abstraction,
  static then adaptive.
- `docs/m3-exploration-report.md`, `docs/m3-5-refinement-report.md` — the DFS engine and
  the transient-state / settle-loop refinements.
- `docs/m4-props-report.md` — prop generation and multi-assignment merging.
- `docs/m5-report-notes.md` — M5's per-component report-usefulness judgement.
- `docs/m6-baseline-report.md` — the transient-chain collapse transform and the
  approve/diff mechanism, including the rekey-vs-regression distinction.
- `docs/poc-outcome.md` — the closing assessment of the whole PoC: what worked, what
  didn't, concrete limits, and what's next.

## Status

137 tests passing, 1 correctly skipped outside a real `npm run explore` invocation (the
CLI driver test). `npm run typecheck` passes with strict TypeScript throughout. All six
milestones (M0–M6) are implemented and tested; see `docs/poc-outcome.md` for the honest
assessment of what that evidence does and doesn't support.
