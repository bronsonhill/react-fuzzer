# M5 report notes: is the output actually reviewable?

This is Deliverable E: an honest per-component judgement on the generated HTML reports in
`examples/`, answering the question docs/poc-plan.md poses for the whole project — can a
developer look at the discovered graph and decide in a few minutes whether it matches what
they intended, or is it noise they have to fight through first?

The judgement below is based on reading the actual generated JSON (the ground truth the
HTML renders from) and the corresponding HTML for each of the seven benchmark components.
Numbers are merged-graph totals (example props plus generated assignments).

## Toggle — 2 states, 4 edges, reviewable

Trivial by construction and the report reflects that: two states (`on`/`off`), no
transient states, no generated-props states (a boolean prop can't gate a branch by
itself here). A developer opens this, sees two boxes and two arrows, and is done in
five seconds. This is the floor case and the report doesn't get in the way of it.

## PropGated — 4 states, 10 edges, reviewable, and the provenance tiers earn their keep

The report is where the provenance design actually pays off. Two states
(`notificationsOn` toggled) show as `default-props`; two more (the `expertModeOn`
states, only reachable when `mode="advanced"`) show as `generated-props`, and the
prop-analysis section correctly names `mode` as the isolated responsible prop. A
developer reading this report learns something true and actionable in well under a
minute: the component has a branch the example props never exercise, and here is
exactly which prop assignment reaches it. This is the single clearest case in the
corpus for why the tool exists.

## FetchList — 4 states, 5 edges, reviewable

Loading/error/empty/loaded, one transient "loading" state en route, two of the four
states generated-props (the `fetchItems` outcome variants). Small enough that the
diagram and the table both stay legible; the transient loading state is correctly
excluded from having its own seeded actions and is visually flagged. No complaints
here.

## Wizard — 8 states, 46 edges, reviewable with effort

Eight states is still countable, but 46 edges on an 8-node diagram is a dense tangle —
this is a 3-step form with per-field fill actions, so the branching factor per state is
high even though the state count is low. The state *table* stays useful (each row is
one state, one witness), but the *diagram* is close to the point where a developer
would give up on visually tracing individual paths and use it only to confirm the rough
shape (three step states plus validation-failure detours) rather than to check every
transition. Table-first review works; diagram-first review starts to strain here.

## ValidatedForm — 10 states, 120 edges, not really reviewable as a diagram

120 edges over 10 nodes is dense enough that the rendered diagram is closer to a solid
mass of lines than a state machine a person can trace by eye — this is the validation
matrix (multiple fields, multiple validity states, multiple fill values per field)
combining multiplicatively. The state table remains the only practical way to review
this component's output: 10 rows, each with a clear witness, is still scannable. The
diagram should be treated as a "does the rough shape look right" gut check, not a
transition-by-transition review tool, and the report doesn't currently say that loudly
enough — it renders the same as an 8-edge diagram, just denser. A dedicated "edges
grouped by source state" view, or collapsing parallel edges between the same two nodes
into one labelled-with-a-count edge, would help here and at Wizard's scale; today the
report does neither, so ValidatedForm's diagram is decoration, not documentation, and
the honest recommendation is to review it via the table and treat the diagram as
skippable for this component.

## Counter — 12 merged states, reviewable, but only via the table, and only once you
## know what you're looking at

This is one of the two components the coordinator specifically asked about, so here is
the direct answer: yes, a developer can review this in a few minutes and correctly judge
whether the states are intended ones, but only by reading the state table, not by
staring at the diagram first.

What's actually in the 12 states: 7 states from the example props (`min=0, max=5,
start=0`) forming the intended chain 0→1→2→3→4→5, correctly showing the clamp behaviour
at both ends — plus one extra state, `value=-1`, that is `generated-props` and reached
from the *same* `s0` node (value=0) but only under a differently-bounded assignment
(`min=-4, max=5`). The remaining 5 states are single-node self-loop graphs from
assignments where `min`/`max`/`start` collapse the whole component to one point (e.g.
`min=94, max=-98` — an inverted, degenerate range fast-check is entitled to generate
since nothing in the prop type says `min <= max`). Every one of these is a legitimate,
correctly-labelled finding: the merged graph is telling the truth about what the
component's declared prop contract allows.

What defeats a diagram-first read: the mermaid rendering shows `s0` and `s6` (the
`value=-1` state) as if they were two nodes in one flowing graph, but the edge between
them is `generated-props` only — a transition that never happens under the props this
component actually ships with. Before this milestone's edge-provenance-label fix
(`[gen]` prefix on generated-only edges, added while writing this report), that edge
was visually indistinguishable from the six `default-props` edges around it, and a
developer skimming the diagram would have read "0 can go to -1" as a real bug in the
example configuration rather than a hypothetical under a widened prop range. With the
`[gen]` label now in place this is fixed, but it is worth being explicit that the
diagram alone, without the label, would have been actively misleading here — this is
exactly the kind of case the state *table*, with its explicit `provenance` column, was
built to make unambiguous, and diagram legibility should not be trusted on its own for
any component with a shared node between default and generated runs.

The five degenerate single-state assignments are visual clutter in the diagram (five
disconnected blobs, each with a self-loop, floating off to one side) but are not hard to
dismiss once you notice they're each a single node — a developer scanning the diagram
for "the real state machine" filters them out quickly by shape. In the table they are
five one-line rows with an obviously degenerate prop assignment printed in the witness,
equally quick to dismiss. Net judgement: reviewable, table-first, and the `[gen]` edge
label is a real (if small) fix that this milestone needed to add for the report to be
honest rather than merely present.

## DebouncedSearch — 18 merged states (12 transient), not comprehensible as currently
## presented; this is the corpus's genuine failure case

This is the other component the coordinator asked about directly, and the honest answer
here is no: a developer cannot review this report in a few minutes and come away
confident about what states are intended, and the presentation is a real part of the
problem, not just the component's inherent complexity.

What's in the 18 states: `idle` plus, for each of the three query terms exercised
(`errorterm`, `emptyterm`, `resultsterm`), a `waiting` → `searching` → `{error |
no-results | results}` chain — 3 terms × (2 transient + 1 settled) = 9, plus a second
copy of that same 9-state shape reached after first typing a different term (the
witness for, e.g., `s16` is *four* fill actions long: `errorterm`, `emptyterm`,
`resultsterm`, `errorterm` again, even though the state itself only reflects the last
fill). That accumulation is exactly the "DebouncedSearch state inflation from action
granularity" the plan warns about: because the text field is filled with entire strings
rather than character-by-character, and because DFS revisits already-tried actions
during backtracking, states that are semantically identical to a hand-authored model's 6
states (idle, waiting, searching, results, empty, error) get split by *how the input
was typed to get there*, not by any real difference in behaviour.

What specifically defeats review:

- **Transient states dominate the diagram.** 12 of 18 nodes are transient
  (waiting/searching), which are not states a developer would ever hand-author — they
  exist only because settle() observes every commit on the way to quiescence. They are
  visually marked (dashed border) but there is no way to collapse or hide them in the
  current report, so two-thirds of every diagram and table row is scaffolding around
  the 6 states that actually matter.
- **Witnesses are long and don't visually collapse duplicates.** The witness column
  faithfully shows the full action sequence (which is the right instinct — the plan
  explicitly asks for witnesses in full, not truncated), but nothing in the table
  signals "these three states are the same shape reached by different paths," so a
  developer has to read all 18 rows' witnesses to notice the repetition themselves.
- **The diagram at 18 nodes is past the point of being traceable by eye**, even before
  accounting for the transient-state clutter; this report does cross the
  large-graph-warning threshold and displays the warning banner, which is honest, but a
  warning is not a fix.

What would fix it, concretely: a "collapse transient chains" view — group each
`(action) → waiting → searching → settled` run into a single labelled edge from the
pre-action state straight to the settled state, with the transient intermediates
available on click/expand rather than always rendered — would cut this diagram from 18
nodes to roughly the intended 6-7 immediately, since the transient states carry no
distinct information beyond "this transition is async." That is a genuine gap in this
milestone's presentation, not a defect in the underlying graph (the graph itself is
correct; DebouncedSearch really does pass through `waiting`/`searching` as distinct,
real, observable commits). Given the scope of M5, this collapsing view was not built;
the state table's `transient` column is the only mitigation currently in the report, and
it is not sufficient on its own to make an 18-row table feel reviewable in a few
minutes.

## Summary

| Component | States (transient) | Edges | Reviewable? |
|---|---|---|---|
| Toggle | 2 (0) | 4 | yes, trivially |
| PropGated | 4 (0) | 10 | yes — the best demonstration of provenance's value |
| FetchList | 4 (1) | 5 | yes |
| Wizard | 8 (0) | 46 | yes, via the table; diagram is dense |
| ValidatedForm | 10 (0) | 120 | table only; diagram is not usable for transition-level review |
| Counter | 12 (0) | 32 | yes, via the table; the `[gen]` edge label added this milestone was necessary for the diagram to not mislead |
| DebouncedSearch | 18 (12) | 72 | **no** — transient-state volume and action-granularity duplication need a collapsing view this milestone did not build |
