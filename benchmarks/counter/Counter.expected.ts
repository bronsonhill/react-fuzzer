import type { ExpectedMachine } from "../types.js";

// Default props: min=0, max=5, start=0.
export const expected: ExpectedMachine = {
  component: "Counter",
  defaultProps: { min: 0, max: 5, start: 0 },
  states: [
    { id: "min", description: "value === min (0); decrement disabled, increment enabled" },
    { id: "mid", description: "min < value < max (1-4); both buttons enabled" },
    { id: "max", description: "value === max (5); increment disabled, decrement enabled" },
  ],
  transitions: [
    { from: "min", action: "click increment", to: "mid", note: "0 -> 1" },
    { from: "mid", action: "click increment", to: "mid", note: "e.g. 1 -> 2, 3 -> 4; self-loop under abstraction" },
    { from: "mid", action: "click increment", to: "max", note: "4 -> 5" },
    { from: "mid", action: "click decrement", to: "mid", note: "e.g. 4 -> 3, 2 -> 1; self-loop under abstraction" },
    { from: "mid", action: "click decrement", to: "min", note: "1 -> 0" },
    { from: "max", action: "click decrement", to: "mid", note: "5 -> 4" },
    { from: "min", action: "click decrement", to: "min", note: "no-op, button is disabled at min so this is unreachable via UI" },
    { from: "max", action: "click increment", to: "max", note: "no-op, button is disabled at max so this is unreachable via UI" },
  ],
  notes: [
    "The raw value has 6 concrete levels (0-5) but is abstracted to min/mid/max, matching the plan's min-mid-max style bucketing for bounded numeric state. This loses the exact count but keeps the boundary behaviour, which is the part that actually gates UI (disabled attributes).",
    "mid -> mid self-loop transitions are real at the concrete level (1->2, 2->3, 3->4 are all distinct) but collapse to one abstract transition. Flagging this as a judgement call: a finer abstraction would need 6 states, which seems like overkill for a component with no behavioural difference between 'mid' values.",
    "The min->min and max->max transitions listed are logically defined by the clamping in the state updater but never actually fire from the UI because the corresponding button is disabled; they are included for completeness of the state machine definition, not as reachable UI transitions.",
  ],
};
