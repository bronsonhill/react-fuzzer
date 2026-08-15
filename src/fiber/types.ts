/**
 * Public types for the fiber adapter. Nothing outside src/fiber should need
 * to import anything but this module (plus devtoolsHook's onCommit/install
 * exports) to consume commit data.
 */

export type HookKind =
  | "state"
  | "reducer"
  | "ref"
  | "memo"
  | "callback"
  | "effect"
  | "context"
  | "unknown";

export interface HookRecord {
  /** Position in the hook list, 0-based. */
  index: number;
  kind: HookKind;
  /**
   * memoizedState for state/reducer hooks. Deliberately undefined for
   * effect/memo/callback/ref hooks: capturing raw memoizedState there risks
   * serialising functions and effect-internal circular structures that M2
   * has no use for.
   */
  value: unknown;
}

export interface ComponentSnapshot {
  componentName: string;
  /** Stable path from the mount root, e.g. "App/PropGated", for disambiguating multiple instances of the same component. */
  path: string;
  hooks: HookRecord[];
}

export interface CommitSnapshot {
  components: ComponentSnapshot[];
  commitIndex: number;
}

/**
 * Opaque handle to whatever react-dom actually passes onCommitFiberRoot.
 * Nothing outside src/fiber should dereference this directly; it's threaded
 * through devtoolsHook -> extract as an unknown so the rest of the codebase
 * cannot accidentally reach into fiber internals.
 */
export type OpaqueFiberRoot = unknown;
