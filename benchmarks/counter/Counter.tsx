import { useState } from "react";

export interface CounterProps {
  min?: number;
  max?: number;
  start?: number;
}

/**
 * Increment/decrement counter clamped to [min, max]. The clamped bounds are
 * real, distinct states: at min the decrement button is disabled, at max the
 * increment button is disabled.
 */
export function Counter({ min = 0, max = 5, start = 0 }: CounterProps) {
  const [value, setValue] = useState(start);

  const atMin = value <= min;
  const atMax = value >= max;

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
        disabled={atMax}
        onClick={() => setValue((v) => Math.min(max, v + 1))}
      >
        +
      </button>
    </div>
  );
}
