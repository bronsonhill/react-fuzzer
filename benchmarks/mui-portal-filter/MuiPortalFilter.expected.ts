import type { ExpectedMachine } from "../types.js";

export const expected: ExpectedMachine = {
  component: "MuiPortalFilter",
  defaultProps: { confirmClear: true },
  states: [
    { id: "all_closed", description: "status='all', dialog closed" },
    { id: "all_confirming", description: "status='all', confirm dialog open" },
    { id: "open_closed", description: "status='open' after picking Open from the Select menu" },
    { id: "closed_closed", description: "status='closed' after picking Closed from the Select menu" },
    { id: "open_confirming", description: "status='open', confirm dialog open" },
    { id: "closed_confirming", description: "status='closed', confirm dialog open" },
  ],
  transitions: [
    { from: "all_closed", action: "select Open", to: "open_closed" },
    { from: "all_closed", action: "select Closed", to: "closed_closed" },
    { from: "open_closed", action: "click Clear all", to: "open_confirming" },
    { from: "closed_closed", action: "click Clear all", to: "closed_confirming" },
    { from: "all_closed", action: "click Clear all", to: "all_confirming" },
    { from: "open_confirming", action: "click Cancel", to: "open_closed" },
    { from: "open_confirming", action: "click Confirm", to: "all_closed" },
    { from: "closed_confirming", action: "click Cancel", to: "closed_closed" },
    { from: "closed_confirming", action: "click Confirm", to: "all_closed" },
    { from: "all_confirming", action: "click Cancel", to: "all_closed" },
    { from: "all_confirming", action: "click Confirm", to: "all_closed" },
  ],
  notes: [
    "This is the negative benchmark: the tool finds 2 of these 6 states and 2 of these 11 transitions, and the gap is structural, not a budget or abstraction issue. Both missing surfaces render through a React portal into document.body — MUI's Select mounts its option list in a Menu portal, Dialog mounts its whole body in one — and src/explore/actions.ts only queries the RTL container.",
    "The Select trigger is not discovered either, for a second and separate reason: it is a div with role='combobox', and the clickable query in discoverActions matches button, a[href], [role='button'] and input buttons only. So there is no action that opens the menu in the first place, and status is frozen at 'all' for the whole run.",
    "MUI's Select also renders a hidden native input holding the selected value. Discovery picks it up as three fill actions and files all three under `unavailable` with reason 'hidden' (it carries aria-hidden='true'). Writing to it would not change component state anyway — MUI does not listen to it — so 'hidden' is the right call here, coincidentally.",
    "What the tool does report is accurate as far as it goes: 2 states (dialog closed / dialog open) and the Clear all click between them, with no false transitions and no replay divergences. The honest reading of this report is 'the confirm dialog has a state; the filter itself was never driven', and a developer reviewing it should notice the missing Cancel/Confirm edges immediately.",
    "Fixing this properly means discovering actions across portal roots (walking document.body, or the container plus any element whose React tree roots inside the component) and giving discoverActions a role-based clickable rule rather than a tag-based one. Neither is done; see README.md's known constraints.",
  ],
};
