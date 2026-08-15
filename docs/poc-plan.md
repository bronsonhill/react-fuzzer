# react-fuzzer proof of concept: plan

## What we are building

A tool that takes a React component, explores it by generating props and driving
interactions, and produces a state graph: the distinct states the component can be in and
the transitions between them. The developer reviews that graph, confirms the states are
the intended ones, and approves it as a baseline that later runs are diffed against.

The gap this fills is specific. `@xstate/test` and `react-automata` derive tests from a
hand-written model. `fast-check-frontend` generates random interaction sequences and checks
invariants but produces no model. Nothing currently derives the model from the component
and shows it to you.

## Non-goals for the PoC

Not a general app crawler; the unit is a component or a small tree, not a route. Not an
assertion framework; the output is a reviewed model, not a pass/fail suite (the baseline
diff in M6 is the first step toward that, no further). No browser-based exploration, no
visual or layout state, no CSS. No support for Redux/Zustand/external stores in the state
abstraction. No published npm package.

## Core design decisions

### Fuzz props, reach state

Props come from outside the component, so any value satisfying the declared prop type is
something a parent could legally pass. Generating them is sound. Internal state is produced
by the component's own logic, so a state that is written directly into the fiber has no
guarantee of being achievable and carries no transition. Internal state is therefore only
ever *reached*, by mounting and interacting.

### Provenance, not a reachability boolean

Every state and edge records how it was obtained, with a witness. Three tiers, in
descending priority for the developer:

| Tier | Meaning | Witness |
|---|---|---|
| `default-props` | Reached under the developer-supplied example props | Action sequence from mount |
| `generated-props` | Reached only under a generated prop assignment | Prop assignment + action sequence |
| `injected` | Forced by writing fiber state directly | None |

`generated-props` states are real with respect to the declared prop contract but may not
occur in the app as written. The usual actionable reading is that the prop type is wider
than actual usage, and the fix is to narrow the type rather than to handle the state.
`injected` is schema-only in the PoC; it is not produced. Its later use is answering "the
explorer never reached this, is it reachable at all?", which is only worth asking once the
explorer is trusted.

### State identity comes from hook values, not the DOM

React exposes `__REACT_DEVTOOLS_GLOBAL_HOOK__`, and the renderer calls `onCommitFiberRoot`
on every commit. Hooking that yields per-commit `useState`/`useReducer` values for the
instrumented subtree. A state identity built from canonicalised hook values corresponds far
more closely to what a developer means by "a state" than a DOM hash does, and is far more
stable across refactoring. Fiber internals are unstable across React versions; the PoC pins
one version and isolates the traversal behind a single adapter module.

### Replay from root for backtracking

Depth-first exploration must return to a previously visited state to try its untried
actions. Restoring state directly reintroduces the unreachability problem and cannot
restore anything outside the fiber (module-level variables, timers, mock state). So we
replay: unmount, remount with the same props, re-execute the recorded action sequence. This
is quadratic in graph size, which is the reason the engine runs in jsdom rather than a real
browser, and the reason M0 sets an explicit budget.

## Stack

TypeScript throughout. Vitest with the jsdom environment as the runner. React Testing
Library and `user-event` for action execution. `fast-check` for prop generation, chosen for
its shrinking, which turns a long failing sequence into a minimal reproduction. The
TypeScript compiler API via `ts-morph` for prop type extraction, in preference to
`react-docgen-typescript`, which does not reliably resolve imported or externally declared
types. Mermaid for graph rendering in the report.

## Milestones

### M0. Benchmark corpus and budget

Before any engine work, write five to seven components in `benchmarks/`, each paired with
a hand-written statechart in a `.expected.ts` file describing the states and transitions
the author intends. Range from a toggle and a counter through a three-step wizard, a form
with validation, a fetch-backed list with loading/error/empty/loaded, and one deliberately
awkward case (a debounced search input).

The hand-written machines are the evaluation criterion for everything that follows. Missing
states means exploration is too weak; extra states means the abstraction is too fine.
Judging the output by whether the diagram looks reasonable is not a signal.

Also fix the budget here: maximum actions per run, maximum states, wall-clock ceiling. Set
it, measure against it at every milestone, and record when it is hit.

### M1. Commit instrumentation

A module that subscribes to `onCommitFiberRoot`, walks the fiber tree for the mounted
subtree, and extracts each function component's ordered hook values with their kinds
(`useState`, `useReducer`, other). Output is a `CommitSnapshot`. Isolate all fiber
traversal here.

Includes quiescence: after an action, run `act()` with fake timers, drain pending
microtasks and timers in a bounded settle loop, and record the state only once no further
commits occur. Bound exceeded means the transition is marked unstable, not silently
recorded. This is where flakiness will originate, so it gets attention now rather than at
the end.

Exit criterion: for every benchmark component, hook values are read correctly and settle
detection is stable across 100 repeated runs.

### M2. State abstraction

A canonicalisation function from `CommitSnapshot` to a state key. Booleans and small unions
kept verbatim; strings reduced to empty/non-empty; arrays and maps to empty/one/many;
numbers to a sign-and-zero bucket; anything unrecognised to a type tag. Hooks are addressed
by a stable identifier (component name plus hook index plus inferred variable name from
source) rather than raw position, so that reordering hooks does not churn the state
identity.

Provide a per-component override so the developer can supply their own abstraction
function. Some components will need it and pretending otherwise wastes time.

Exit criterion: on the benchmark corpus, the state count produced by the abstraction
matches the hand-written machines under exhaustive manual interaction, with a documented
account of every mismatch.

### M3. Exploration engine

Action discovery: enumerate interactive elements in the rendered output (buttons, links,
inputs, selects, elements with handlers or roles) and produce candidate actions. Function
props are also exposed as actions, since a parent invoking a callback is a legitimate
transition.

Exploration: depth-first over a frontier of `(state, untried action)` pairs, replaying from
root to backtrack. Record every transition with its provenance and witness. Determinism
check: a transition observed to lead to different states from the same origin is flagged as
non-deterministic rather than recorded, which surfaces unmocked async and animation rather
than corrupting the graph.

Run with fixed example props throughout this milestone. Everything produced here is
`default-props` provenance.

Exit criterion: graphs for the benchmark corpus compared node-by-node and edge-by-edge
against the hand-written machines, with the discrepancies written up.

### M4. Prop generation

Extract the props interface with `ts-morph` and map types to `fast-check` arbitraries.
Provide an explicit override map, because callbacks, `ReactNode` children, and unions with
domain meaning will not generate sensibly and should not be guessed at.

Sample N prop assignments. Run a full M3 exploration per assignment, producing one graph
each. Merge: states and edges present under the example props keep `default-props`
provenance, states appearing only under generated props are marked `generated-props` with
the assignment recorded. Report which prop assignments produce structurally distinct
graphs, since "these props change the shape of the machine" is the useful finding, and
folding props into state identity would only multiply the state count without adding
insight.

Exit criterion: on a component with a prop that gates a branch, the gated states appear
with correct provenance and the responsible prop assignment is identified.

### M5. Report

A single self-contained HTML file: a Mermaid state diagram with provenance shown by edge
and node styling, a table of states with their witnesses, the list of non-deterministic
transitions, the prop assignments that changed the graph shape, and the budget usage. Plus
machine-readable JSON as the durable artefact.

### M6. Approval baseline (stretch)

`approve` writes the current graph to a checked-in baseline with developer-supplied state
names. Later runs diff against it and report new states, lost transitions, and provenance
changes. This is the point where the tool becomes a regression check rather than a
visualisation, and it depends entirely on state identities being stable enough that a
refactor does not produce a page of spurious diffs. If M2 does not deliver that stability,
this milestone is not worth building yet.

## Known risks

Applicability boundary. Fully controlled components hold no internal state and will
correctly produce a single-node graph. State in Context or an external store does not
appear in the target's hooks. The PoC targets self-contained stateful components and mounts
a small tree rather than a single component, so state one level up stays inside the
instrumented boundary. This limitation is real and should be stated in the README rather
than engineered around.

Fiber instability. Pinned React version, single adapter module, adapter breakage expected
on major React upgrades.

Replay cost. Quadratic backtracking caps graph size. Budget is set in M0 and measured
throughout; if it binds early, the mitigation is a bounded exploration depth with the
unexplored frontier reported, not a switch to state injection.

jsdom blindness. Anything expressed only in layout or computed style is invisible. Accepted
for the PoC.
