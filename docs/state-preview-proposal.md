# Proposal: previewing a state's rendered output in the report

Status: proposed, not built. Written for whoever picks this up next.

## The ask

In the HTML report, hovering a state node in the diagram (or a row in the state table)
should show what the component actually looked like in that state.

## Why this is cheap

The exploration engine already holds the live DOM for every state at the moment that state
existed. `settle()` takes an `onCommit` callback (`src/settle.ts`, see the comment on the
field) that fires synchronously as each commit lands, specifically because by the time
`settle()` returns the DOM only reflects the final commit. The engine uses that window today
to call `computeDomFingerprint(container)` — five call sites in `src/explore/engine.ts`,
lines 249, 273, 314 and neighbours.

That is exactly the point where the markup for a state is available and nowhere else.
Capturing it is one more line beside the fingerprint call. No new plumbing, no second run.

## Three options, in ascending cost

### Option 1: store the rendered markup (recommended)

Capture `container.innerHTML` at each `onCommit`, store it on the state, inline it in the
report, and render it into an `<iframe srcdoc>` in a hover card. Iframe rather than a div,
so the report's own stylesheet does not bleed into the component.

Estimated half a day.

Touchpoints:

- `src/explore/engine.ts` — capture next to `computeDomFingerprint`. Reuse the same
  normalisation pass from `src/abstraction/domFingerprint.ts` so React-internal attributes
  do not end up in the stored markup.
- `src/explore/graph.ts` — add `html?: string` to `StateNode`.
- `src/report/json.ts` — normalise before serialising. M5 guarantees byte-identical JSON
  across two runs of the same component, and unnormalised markup will break that. There is
  an existing test asserting it (`test/report/json.test.tsx`); it must keep passing.
- `src/report/html.ts` — the hover card, plus `srcdoc` escaping.

Size is not a concern: `DebouncedSearch` has 18 states, each a few hundred bytes of markup.

The real limitation is CSS. jsdom never loads the application's stylesheet, so captured
markup is structurally accurate and visually unstyled. Class names are all present; the
rules that give them meaning are not. Plain CSS and a compiled Tailwind build can be
recovered by adding a config field pointing at a stylesheet to inline into each `srcdoc`.
CSS-in-JS that injects rules at runtime cannot.

Whether that matters depends on the question being asked. For "is this the state I
intended?", structure and text usually suffice: a disabled Next button and an empty error
slot read fine without styling.

### Option 2: real screenshots

jsdom does not paint, so this needs Playwright.

Do **not** port the exploration engine to Playwright. `ValidatedForm` explores in 186ms
under jsdom; the same run over CDP would take tens of seconds, and the fiber instrumentation
in `src/fiber/` would have to move into the page and communicate back over an evaluate
bridge.

Split the work instead. Explore in jsdom as now, then run a separate screenshot pass: for
each state, launch the component in a real browser, replay its witness, screenshot. Every
state already carries a replayable action sequence in `witness.actions` (this is what the
M3 witness design was for), so the screenshotter needs no exploration logic.

Estimated 2 to 3 days: Playwright dependency, a bundling step to get the component into a
page, an action executor that speaks Playwright rather than Testing Library, and
PNG-to-data-URI embedding to keep the report self-contained (M5 requires zero external
requests). Cost per report is roughly states × witness length × ~50ms, so under a minute
for anything inside the 50-state budget in `src/budget.ts`.

Worth it only if pixel fidelity against the app's real CSS is the actual requirement.

### Option 3: live interactive render

Bundle the component with esbuild, inline the bundle in the report, mount a fresh instance
on hover and replay the witness, giving a working component the reviewer can click.

Estimated 3 to 4 days. Bundling is the easy half. The hard half is that the report must
carry the same mocks exploration used: `examples/configs/fetch-list.config.ts` supplies a
three-way `fetchItems` arbitrary as a TypeScript closure, and that has to end up executable
inside the page. Realistically the config module gets bundled too and invoked at hover time.

## The constraint that decides between them

Transient states cannot be live-rendered. `src/explore/graph.ts` documents why on the
`witness` field: replaying a transient state's actions and settling runs straight past it,
because holding a component at `loading` means freezing the timers and promises that put it
there. Same structural wall M3.5 hit.

Two thirds of `DebouncedSearch`'s 18 states are transient. Half of `FetchList`'s. Option 3
therefore fails on precisely the states that were hardest to discover and are the most
interesting to inspect — loading, submitting, debouncing.

Option 1 is unaffected. The markup was captured at that commit; a stored snapshot does not
care that the moment has passed.

## Recommendation

Build Option 1, with an optional stylesheet path in the config. Half a day, the capture
point already exists, and it covers the transient states the more elaborate approaches
structurally cannot.

If unstyled markup proves unreadable in practice, add Option 2's screenshot pass for settled
states only and leave transient states on stored markup.

Option 3 costs the most and goes blind exactly where a reviewer most wants to look.

## Acceptance criteria for Option 1

1. Every state in the generated report, transient included, has a preview.
2. `test/report/json.test.tsx` still passes: two runs of the same component produce
   byte-identical JSON.
3. Reports remain self-contained. No external requests of any kind (M5 requirement).
4. Previews render correctly in both light and dark theme, and the hover card does not make
   the page body scroll horizontally.
5. Regenerate `examples/` and confirm the collapsed-diagram view from M6 still renders.
6. State the CSS limitation in the README next to the existing applicability boundary.
   Someone should be able to tell before installing that previews arrive unstyled unless
   they supply a stylesheet.
