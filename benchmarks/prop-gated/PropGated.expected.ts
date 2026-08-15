import type { ExpectedMachine } from "../types.js";

export const expected: ExpectedMachine = {
  component: "PropGated",
  defaultProps: { mode: "simple" },
  states: [
    { id: "simple_notif-off", description: "mode='simple', notificationsOn=false; only Notifications button rendered" },
    { id: "simple_notif-on", description: "mode='simple', notificationsOn=true; only Notifications button rendered" },
    { id: "advanced_notif-off_expert-off", description: "mode='advanced', both toggles off; only reachable when mode='advanced'" },
    { id: "advanced_notif-on_expert-off", description: "mode='advanced', notifications on, expert off" },
    { id: "advanced_notif-off_expert-on", description: "mode='advanced', notifications off, expert on" },
    { id: "advanced_notif-on_expert-on", description: "mode='advanced', both on" },
  ],
  transitions: [
    { from: "simple_notif-off", action: "click Notifications", to: "simple_notif-on" },
    { from: "simple_notif-on", action: "click Notifications", to: "simple_notif-off" },
    { from: "advanced_notif-off_expert-off", action: "click Notifications", to: "advanced_notif-on_expert-off" },
    { from: "advanced_notif-off_expert-off", action: "click Expert mode", to: "advanced_notif-off_expert-on" },
    { from: "advanced_notif-on_expert-off", action: "click Notifications", to: "advanced_notif-off_expert-off" },
    { from: "advanced_notif-on_expert-off", action: "click Expert mode", to: "advanced_notif-on_expert-on" },
    { from: "advanced_notif-off_expert-on", action: "click Notifications", to: "advanced_notif-on_expert-on" },
    { from: "advanced_notif-off_expert-on", action: "click Expert mode", to: "advanced_notif-off_expert-off" },
    { from: "advanced_notif-on_expert-on", action: "click Notifications", to: "advanced_notif-off_expert-on" },
    { from: "advanced_notif-on_expert-on", action: "click Expert mode", to: "advanced_notif-on_expert-off" },
  ],
  notes: [
    "This is the M4 target component. Under default props (mode='simple') only the two simple_* states and the transition between them are reachable at all; the four advanced_* states exist only under a generated prop assignment of mode='advanced'. A correct M4 report should mark the advanced_* states/transitions with generated-props provenance and identify mode as the responsible prop.",
    "expertModeOn is a real useState hook that exists even in 'simple' mode (it is unconditionally called), but with no button rendered to toggle it there is no action that changes it, so it is permanently false under mode='simple' and does not multiply the simple_* state count. This is the point of the benchmark: internal state that exists in the fiber but is behaviourally unreachable given the current props must not appear as a distinct state.",
    "mode is not itself part of the internal hook-derived state identity (it's a prop, not a hook), so the two branches (simple vs advanced) are really two different reachable subgraphs of the same component, not one component with a 'mode' state variable. The state ids above prefix with the mode purely for human readability in this table.",
  ],
};
