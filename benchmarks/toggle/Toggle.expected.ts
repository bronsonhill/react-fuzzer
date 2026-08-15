import type { ExpectedMachine } from "../types.js";

export const expected: ExpectedMachine = {
  component: "Toggle",
  defaultProps: { label: "Power" },
  states: [
    { id: "off", description: "on === false, button reads 'Off', aria-pressed=false" },
    { id: "on", description: "on === true, button reads 'On', aria-pressed=true" },
  ],
  transitions: [
    { from: "off", action: "click button", to: "on" },
    { from: "on", action: "click button", to: "off" },
  ],
};
