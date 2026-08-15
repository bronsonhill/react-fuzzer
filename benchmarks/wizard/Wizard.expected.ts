import type { ExpectedMachine } from "../types.js";

export const expected: ExpectedMachine = {
  component: "Wizard",
  defaultProps: "onComplete omitted (optional callback prop, not required to reach any state)",
  states: [
    { id: "step1-empty", description: "step === 1, name is empty; Next disabled" },
    { id: "step1-filled", description: "step === 1, name is non-empty; Next enabled" },
    { id: "step2-empty", description: "step === 2, email is empty; Next disabled, Back enabled" },
    { id: "step2-filled", description: "step === 2, email is non-empty; Next enabled, Back enabled" },
    { id: "step3", description: "step === 3, review screen shown; Back and Finish enabled" },
    { id: "done", description: "done === true; wizard replaced by 'Wizard complete' status text" },
  ],
  transitions: [
    { from: "step1-empty", action: "type into name field", to: "step1-filled" },
    { from: "step1-filled", action: "clear name field", to: "step1-empty" },
    { from: "step1-filled", action: "click Next", to: "step2-empty", note: "email starts empty on first visit to step 2" },
    { from: "step2-empty", action: "type into email field", to: "step2-filled" },
    { from: "step2-filled", action: "clear email field", to: "step2-empty" },
    { from: "step2-empty", action: "click Back", to: "step1-filled", note: "name is still filled from step 1" },
    { from: "step2-filled", action: "click Back", to: "step1-filled" },
    { from: "step2-filled", action: "click Next", to: "step3" },
    { from: "step3", action: "click Back", to: "step2-filled", note: "email is still filled from step 2" },
    { from: "step3", action: "click Finish", to: "done" },
  ],
  notes: [
    "step1-empty is only reachable as the initial state or by clearing a filled name field; once step2 is reached the name field is guaranteed non-empty (Next was disabled otherwise), so 'step2 with name empty' is not a reachable state and is correctly absent from this machine.",
    "Field contents (the actual string value of name/email) are abstracted to empty/non-empty per the plan's string bucketing rule; the exact text is not treated as distinct state.",
    "Whether 'step1-empty reached by clearing after having been filled' is truly the same state as 'step1-empty on fresh mount' is a judgement call: both have identical step/name/email/done values so they collapse under hook-value identity, which seems correct here since nothing else distinguishes them.",
  ],
};
