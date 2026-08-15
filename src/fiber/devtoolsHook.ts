/**
 * Installs a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub so react-dom
 * reports every commit to us, and exposes a typed subscription API so the
 * rest of the codebase never touches `globalThis` or fiber internals
 * directly.
 *
 * IMPORTANT: react-dom checks for this global exactly once, at module
 * initialisation, and only calls into it if it was present at that time.
 * This module MUST be imported (and `installDevtoolsHook()` called) before
 * `react-dom` is imported anywhere in the process. In Vitest that means
 * importing it from `test/setup.ts`, since Vitest's setupFiles run and
 * complete before any test module (which is what pulls in react-dom via
 * `@testing-library/react`) is evaluated.
 *
 * Verified empirically against React 19.1.0 in jsdom: react-dom calls
 * `inject(rendererConfig)` once at renderer init and then
 * `onCommitFiberRoot(rendererId, root)` on every commit, where `root` is the
 * FiberRoot (its `.current` is the HostRoot fiber). The other hook methods
 * below (`onCommitFiberUnmount`, `onPostCommitFiberRoot`, `checkDCE`) are
 * called by react-dom in various circumstances but are not needed for
 * extraction; they are kept as no-ops purely so react-dom's calls into the
 * hook don't throw.
 */
import type { OpaqueFiberRoot } from "./types.js";

type CommitListener = (root: OpaqueFiberRoot) => void;

interface DevtoolsHook {
  isDisabled: boolean;
  supportsFiber: boolean;
  renderers: Map<number, unknown>;
  inject(renderer: unknown): number;
  onCommitFiberRoot(rendererId: number, root: OpaqueFiberRoot): void;
  onCommitFiberUnmount(rendererId: number, fiber: unknown): void;
  onPostCommitFiberRoot(rendererId: number, root: OpaqueFiberRoot): void;
  checkDCE(fn: unknown): void;
  __reactFuzzerListeners: Set<CommitListener>;
}

declare global {
  // eslint-disable-next-line no-var
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: DevtoolsHook | undefined;
}

function createHook(): DevtoolsHook {
  let nextRendererId = 1;
  const listeners = new Set<CommitListener>();

  return {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer: unknown): number {
      const id = nextRendererId++;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_rendererId: number, root: OpaqueFiberRoot): void {
      for (const listener of listeners) {
        listener(root);
      }
    },
    onCommitFiberUnmount(): void {
      // no-op: unmount notifications aren't needed for snapshot extraction.
    },
    onPostCommitFiberRoot(): void {
      // no-op.
    },
    checkDCE(): void {
      // no-op: this exists so bundlers/devtools can check for dead-code
      // elimination of the hook itself; irrelevant under Vitest.
    },
    __reactFuzzerListeners: listeners,
  };
}

/**
 * Installs the stub hook if one is not already present. Safe to call
 * multiple times (idempotent) — subsequent calls are no-ops so re-importing
 * this module across test files doesn't clobber existing subscribers.
 *
 * Must run before react-dom is imported/initialised.
 */
export function installDevtoolsHook(): void {
  if (globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.__reactFuzzerListeners) {
    return;
  }
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = createHook();
}

/**
 * Subscribe to every commit react-dom reports. Returns an unsubscribe
 * function. Throws if the hook has not been installed yet.
 */
export function onCommit(cb: CommitListener): () => void {
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook?.__reactFuzzerListeners) {
    throw new Error(
      "react-fuzzer devtools hook is not installed. Call installDevtoolsHook() " +
        "before react-dom is imported (e.g. from test/setup.ts).",
    );
  }
  hook.__reactFuzzerListeners.add(cb);
  return () => hook.__reactFuzzerListeners.delete(cb);
}

// Install eagerly on import. This module must therefore be the first thing
// imported, ahead of react-dom, wherever it's used.
installDevtoolsHook();

// Track the most recently committed root at module scope, independent of
// any particular caller's subscription window. settle() needs this: a
// caller may invoke settle() after an action already produced its commit
// (e.g. fireEvent.change, which commits synchronously), and settle() still
// needs to be able to read that state even if no further commit occurs
// while it's watching.
let lastCommittedRoot: OpaqueFiberRoot | undefined;
let lastCommitIndex = -1;
onCommit((root) => {
  lastCommittedRoot = root;
  lastCommitIndex++;
});

export function getLastCommittedRoot(): { root: OpaqueFiberRoot | undefined; commitIndex: number } {
  return { root: lastCommittedRoot, commitIndex: lastCommitIndex };
}
