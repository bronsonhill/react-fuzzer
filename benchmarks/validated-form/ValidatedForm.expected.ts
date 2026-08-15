import type { ExpectedMachine } from "../types.js";

// email is bucketed to {empty, invalid, valid}; password to {empty, invalid, valid}.
// Cross product gives 9 not-submitted states plus 1 submitted state = 10.
export const expected: ExpectedMachine = {
  component: "ValidatedForm",
  defaultProps: "onSubmit omitted (optional callback prop, not required to reach any state)",
  states: [
    { id: "email-empty_pw-empty", description: "email empty, password empty" },
    { id: "email-empty_pw-invalid", description: "email empty, password 1-7 chars" },
    { id: "email-empty_pw-valid", description: "email empty, password >=8 chars" },
    { id: "email-invalid_pw-empty", description: "email non-empty but not matching email shape, password empty" },
    { id: "email-invalid_pw-invalid", description: "email invalid, password invalid" },
    { id: "email-invalid_pw-valid", description: "email invalid, password valid" },
    { id: "email-valid_pw-empty", description: "email valid, password empty" },
    { id: "email-valid_pw-invalid", description: "email valid, password invalid" },
    { id: "email-valid_pw-valid", description: "both valid; Submit enabled" },
    { id: "submitted", description: "submitted === true; form replaced by 'Submitted' status text" },
  ],
  transitions: [
    { from: "email-empty_pw-empty", action: "type invalid email", to: "email-invalid_pw-empty" },
    { from: "email-empty_pw-empty", action: "type valid email", to: "email-valid_pw-empty" },
    { from: "email-empty_pw-empty", action: "type short password", to: "email-empty_pw-invalid" },
    { from: "email-empty_pw-empty", action: "type >=8 char password", to: "email-empty_pw-valid" },
    { from: "email-invalid_pw-empty", action: "clear email", to: "email-empty_pw-empty" },
    { from: "email-invalid_pw-empty", action: "fix email to valid", to: "email-valid_pw-empty" },
    { from: "email-invalid_pw-empty", action: "type short password", to: "email-invalid_pw-invalid" },
    { from: "email-valid_pw-empty", action: "clear email", to: "email-empty_pw-empty" },
    { from: "email-valid_pw-empty", action: "break email", to: "email-invalid_pw-empty" },
    { from: "email-valid_pw-empty", action: "type short password", to: "email-valid_pw-invalid" },
    { from: "email-valid_pw-empty", action: "type >=8 char password", to: "email-valid_pw-valid" },
    { from: "email-empty_pw-invalid", action: "type valid email", to: "email-valid_pw-invalid" },
    { from: "email-empty_pw-invalid", action: "clear password", to: "email-empty_pw-empty" },
    { from: "email-empty_pw-invalid", action: "extend password to >=8 chars", to: "email-empty_pw-valid" },
    { from: "email-invalid_pw-invalid", action: "fix email to valid", to: "email-valid_pw-invalid" },
    { from: "email-invalid_pw-invalid", action: "extend password to >=8 chars", to: "email-invalid_pw-valid" },
    { from: "email-valid_pw-invalid", action: "extend password to >=8 chars", to: "email-valid_pw-valid", note: "Submit becomes enabled here" },
    { from: "email-valid_pw-invalid", action: "clear password", to: "email-valid_pw-empty" },
    { from: "email-invalid_pw-valid", action: "fix email to valid", to: "email-valid_pw-valid" },
    { from: "email-empty_pw-valid", action: "type valid email", to: "email-valid_pw-valid" },
    { from: "email-valid_pw-valid", action: "click Submit", to: "submitted" },
    { from: "email-valid_pw-valid", action: "clear email", to: "email-empty_pw-valid" },
  ],
  notes: [
    "The email/password abstraction into {empty, invalid, valid} discards the exact string; two different invalid emails (e.g. 'a' vs 'a@') are treated as the same state, matching the plan's string bucketing rule. This is a deliberate loss of fidelity.",
    "This machine lists a representative subset of the full 3x3 transition graph reachable by editing either field independently; the test below exercises a representative path through most cells rather than every possible edit ordering, since the cross-product transitions are largely symmetric and mechanical.",
    "'Invalid' for email specifically means 'non-empty and does not match the email regex', not 'malformed in some particular way' — the validator does not distinguish sub-kinds of invalidity, so neither does this state machine.",
  ],
};
