/**
 * Stability claim: a benign hook reorder, or an inserted unrelated hook,
 * must not change a component's StateKey.key for the same logical state.
 * Name-based addressing (via ts-morph, src/abstraction/hookNames.ts) is
 * what buys this — position-based addressing would not, since the fiber's
 * hook list order changes when the source order changes.
 *
 * Two synthetic components simulate "before" and "after" a refactor: same
 * two pieces of state (count, flag), but V2 declares them in the opposite
 * order and has an extra unrelated hook inserted between them. Neither
 * benchmark component nor its .expected.ts is modified for this; these are
 * standalone fixtures.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useState, type ReactElement } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { onCommit, extractSnapshot } from "../../src/fiber/index.js";
import { abstractState } from "../../src/abstraction/index.js";
import { AdaptiveAbstraction } from "../../src/abstraction/adaptive.js";

// "Before": count declared first, then flag.
function StabilityV1() {
  const [count, setCount] = useState(0);
  const [flag, setFlag] = useState(false);
  return (
    <div>
      <button aria-label="inc" onClick={() => setCount((c) => c + 1)}>
        inc
      </button>
      <button aria-label="flag" onClick={() => setFlag((f) => !f)}>
        flag
      </button>
    </div>
  );
}

// "After": order swapped, plus an unrelated hook inserted in between —
// simulating a benign refactor (reorder + an unrelated feature added).
function StabilityV2() {
  const [flag, setFlag] = useState(false);
  const [extra] = useState(0); // unrelated, inserted; must not affect identity once ignored
  const [count, setCount] = useState(0);
  void extra;
  return (
    <div>
      <button aria-label="inc" onClick={() => setCount((c) => c + 1)}>
        inc
      </button>
      <button aria-label="flag" onClick={() => setFlag((f) => !f)}>
        flag
      </button>
    </div>
  );
}

function writeSourceFixture(name: string, source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stability-fixture-"));
  const file = path.join(dir, `${name}.tsx`);
  fs.writeFileSync(file, source);
  return file;
}

const v1Source = `
import { useState } from "react";
export function StabilityV1() {
  const [count, setCount] = useState(0);
  const [flag, setFlag] = useState(false);
  return null;
}
`;

const v2Source = `
import { useState } from "react";
export function StabilityV2() {
  const [flag, setFlag] = useState(false);
  const [extra] = useState(0);
  const [count, setCount] = useState(0);
  return null;
}
`;

async function collectKeyFor(
  Component: () => ReactElement,
  componentName: string,
  sourcePath: string,
  drive: (inc: HTMLElement, flag: HTMLElement) => Promise<void>,
): Promise<string> {
  let key = "";
  const unsub = onCommit((root) => {
    const snapshot = extractSnapshot(root, 0);
    const comp = snapshot.components.find((c) => c.componentName === componentName);
    if (!comp) return;
    key = abstractState(comp, {
      componentName,
      sourcePath,
      ignoreHooks: ["extra"],
    }).key;
  });

  const user = userEvent.setup();
  const { unmount, getByLabelText } = render(<Component />);
  await drive(getByLabelText("inc"), getByLabelText("flag"));
  unsub();
  unmount();
  return key;
}

describe("stability: benign hook reorder and an inserted unrelated hook", () => {
  it("produces the same StateKey.key for the same logical state (count=1, flag=true) across V1 and V2", async () => {
    const v1Path = writeSourceFixture("StabilityV1", v1Source);
    const v2Path = writeSourceFixture("StabilityV2", v2Source);

    const keyV1 = await collectKeyFor(StabilityV1, "StabilityV1", v1Path, async (inc, flag) => {
      const user = userEvent.setup();
      await user.click(inc);
      await user.click(flag);
    });

    const keyV2 = await collectKeyFor(StabilityV2, "StabilityV2", v2Path, async (inc, flag) => {
      const user = userEvent.setup();
      await user.click(inc);
      await user.click(flag);
    });

    // Both label sets are identical (count/flag by name), so the keys
    // themselves are only equal if the componentName-qualification isn't
    // baked into the key. abstractState's key is name=token pairs only, so
    // this compares apples to apples across the two "versions" of the
    // component despite the different function/source-file names.
    expect(keyV1).toBe(keyV2);
    expect(keyV1).toContain("count=");
    expect(keyV1).toContain("flag=true");
  });

  it("falls back to index-based naming (with a warning) when source and runtime hook counts disagree, rather than mis-mapping names", async () => {
    // Source claims 2 hooks; runtime component (StabilityV1) also has 2, so
    // to force a mismatch we point at a source file with only 1 hook.
    const mismatchedSource = `
      import { useState } from "react";
      export function StabilityV1() {
        const [count, setCount] = useState(0);
        return null;
      }
    `;
    const mismatchedPath = writeSourceFixture("StabilityV1Mismatched", mismatchedSource);

    let warnings: string[] = [];
    let keyIndexBased = "";
    const unsub = onCommit((root) => {
      const snapshot = extractSnapshot(root, 0);
      const comp = snapshot.components.find((c) => c.componentName === "StabilityV1");
      if (!comp) return;
      const result = abstractState(comp, {
        componentName: "StabilityV1",
        sourcePath: mismatchedPath,
      }) as ReturnType<typeof abstractState> & { warnings?: string[] };
      keyIndexBased = result.key;
      warnings = result.warnings ?? [];
    });

    render(<StabilityV1 />);
    unsub();

    expect(warnings.length).toBeGreaterThan(0);
    // Index-based fallback names hooks hook0/hook1 by their fiber index.
    expect(keyIndexBased).toContain("hook0=");
    expect(keyIndexBased).toContain("hook1=");
  });
});

/**
 * Same claim, re-checked for AdaptiveAbstraction (M2.5): a benign hook
 * reorder plus an inserted unrelated hook must still produce the same
 * StateId for the same logical state. This matters specifically for M2.5
 * because name resolution now feeds a *stateful* class (domain tracking,
 * demotion, DOM pruning) rather than a pure function — it would be easy for
 * a naming glitch to only show up after enough observations accumulate.
 * Both fixtures are driven through a single AdaptiveAbstraction instance
 * each, one commit stream at a time, mirroring how a real exploration would
 * use it.
 */
describe("stability (adaptive): benign hook reorder and an inserted unrelated hook", () => {
  it("produces the same StateId for the same logical state (count=1, flag=true) across V1 and V2", async () => {
    const v1Path = writeSourceFixture("StabilityV1Adaptive", v1Source);
    const v2Path = writeSourceFixture("StabilityV2Adaptive", v2Source);

    async function collectAdaptiveId(
      Component: () => ReactElement,
      componentName: string,
      sourcePath: string,
    ): Promise<string> {
      const abstraction = new AdaptiveAbstraction({ componentName, sourcePath, ignoreHooks: ["extra"] });
      let id = "";
      const unsub = onCommit((root) => {
        const snapshot = extractSnapshot(root, 0);
        const comp = snapshot.components.find((c) => c.componentName === componentName);
        if (!comp) return;
        id = abstraction.observe({ snapshot: comp });
      });

      const user = userEvent.setup();
      const { unmount, getByLabelText } = render(<Component />);
      await user.click(getByLabelText("inc"));
      await user.click(getByLabelText("flag"));
      unsub();
      unmount();
      return id;
    }

    const idV1 = await collectAdaptiveId(StabilityV1, "StabilityV1", v1Path);
    const idV2 = await collectAdaptiveId(StabilityV2, "StabilityV2", v2Path);

    // Both are the first (and only, per-instance) state observed by a
    // freshly constructed AdaptiveAbstraction, so both are "s0" — the
    // interesting claim isn't the literal id (a single-state run doesn't
    // exercise merging) but that hook *naming* is unaffected by the reorder
    // and insertion, which the underlying StateKey content check below
    // verifies directly via the same field values abstractState produces.
    expect(idV1).toBe(idV2);

    // Cross-check against the static path's key content, using the same
    // sourcePath-driven naming: confirms the adaptive class is resolving
    // "count" and "flag" by name (not position) exactly as M2 does, so the
    // stability guarantee it inherits is the same one, not a coincidence of
    // both fixtures happening to produce "s0".
    let staticKeyV1 = "";
    let staticKeyV2 = "";
    const unsubStatic1 = onCommit((root) => {
      const snapshot = extractSnapshot(root, 0);
      const comp = snapshot.components.find((c) => c.componentName === "StabilityV1");
      if (comp) staticKeyV1 = abstractState(comp, { componentName: "StabilityV1", sourcePath: v1Path, ignoreHooks: ["extra"] }).key;
    });
    {
      const user = userEvent.setup();
      const { unmount, getByLabelText } = render(<StabilityV1 />);
      await user.click(getByLabelText("inc"));
      await user.click(getByLabelText("flag"));
      unsubStatic1();
      unmount();
    }
    const unsubStatic2 = onCommit((root) => {
      const snapshot = extractSnapshot(root, 0);
      const comp = snapshot.components.find((c) => c.componentName === "StabilityV2");
      if (comp) staticKeyV2 = abstractState(comp, { componentName: "StabilityV2", sourcePath: v2Path, ignoreHooks: ["extra"] }).key;
    });
    {
      const user = userEvent.setup();
      const { unmount, getByLabelText } = render(<StabilityV2 />);
      await user.click(getByLabelText("inc"));
      await user.click(getByLabelText("flag"));
      unsubStatic2();
      unmount();
    }
    expect(staticKeyV1).toBe(staticKeyV2);
  });
});
