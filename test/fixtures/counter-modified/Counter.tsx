import { useState } from "react";

export interface CounterProps {
  min?: number;
  max?: number;
  start?: number;
}

/**
 * M6 test fixture: a deliberately modified COPY of benchmarks/counter/Counter.tsx
 * (never edit the original -- see test/baseline/approve-diff.test.tsx), used to
 * verify that `diff` catches a real behaviour change and nothing else.
 *
 * Deliberately reuses the SAME `value` hook for the new state (rather than
 * adding a second useState) so that the change is isolated to exactly the
 * states it should affect -- adding an independent hook would change every
 * existing state's identity (every state gains a field), which is a real
 * but much noisier effect not what this fixture is testing.
 *
 * Two deliberate changes from the original:
 *  1. ADDED STATE: a new "Ping" button sets `value` to the sentinel -1 (a
 *     value the original clamped range 0..max never produces) and renders a
 *     terminal `<p role="status">pinged</p>` screen with no further actions.
 *     Reachable from every counter value; genuinely new state plus one new
 *     transition into it from each existing state.
 *  2. GATED / REMOVED TRANSITION: increment is now also disabled at
 *     value === 3 (an arbitrary new condition, not present in the original),
 *     which removes the value=3 --increment--> value=4 transition. Because
 *     decrement never increases value, this is the only path that ever
 *     reached value=4/value=5, so gating it also makes those two states
 *     genuinely unreachable -- a real cascading regression the diff test
 *     (test/baseline/approve-diff.test.tsx) deliberately exercises and
 *     expects to see reported as lost states, not just a lost transition.
 */
export function Counter({ min = 0, max = 5, start = 0 }: CounterProps) {
  const [value, setValue] = useState(start);

  if (value === -1) {
    return <p role="status">pinged</p>;
  }

  const atMin = value <= min;
  const atMax = value >= max;
  // Deliberate new gating condition, not present in the original component.
  const incrementBlocked = atMax || value === 3;

  return (
    <div>
      <output aria-label="count">{value}</output>
      <button
        type="button"
        aria-label="decrement"
        disabled={atMin}
        onClick={() => setValue((v) => Math.max(min, v - 1))}
      >
        -
      </button>
      <button
        type="button"
        aria-label="increment"
        disabled={incrementBlocked}
        onClick={() => setValue((v) => Math.min(max, v + 1))}
      >
        +
      </button>
      <button type="button" aria-label="ping" onClick={() => setValue(-1)}>
        Ping
      </button>
    </div>
  );
}
