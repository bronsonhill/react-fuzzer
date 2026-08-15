import { useState } from "react";

export interface ToggleProps {
  /** Text shown alongside the on/off state, for context only. */
  label?: string;
}

/**
 * A boolean on/off button. Trivial baseline for the benchmark corpus.
 */
export function Toggle({ label = "Power" }: ToggleProps) {
  const [on, setOn] = useState(false);

  return (
    <div>
      <span>{label}</span>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setOn((prev) => !prev)}
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}
