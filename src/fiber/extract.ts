/**
 * Fiber tree walk and hook extraction. This is the only file that reaches
 * into fiber-internal shapes (memoizedState, hook.queue, .child/.sibling).
 * Everything here was verified empirically against React 19.1.0 in jsdom
 * (see the notes below and the M1 report) rather than assumed from docs.
 */
import type { CommitSnapshot, ComponentSnapshot, HookKind, HookRecord, OpaqueFiberRoot } from "./types.js";

// FunctionComponent. Confirmed empirically: a plain `function Foo() {...}`
// component shows up with tag === 0. We deliberately do NOT walk
// ForwardRef/Memo/SimpleMemoComponent fibers (tags 11/14/15) — none of the
// benchmark corpus uses them, and including them without empirical
// verification of their hook-list shape would be guessing.
const FUNCTION_COMPONENT_TAG = 0;

interface HookQueue {
  lastRenderedReducer?: unknown;
}

interface Hook {
  memoizedState: unknown;
  queue: HookQueue | null;
  next: Hook | null;
}

interface FiberLike {
  tag: number;
  type: unknown;
  memoizedState: unknown;
  child: FiberLike | null;
  sibling: FiberLike | null;
  return: FiberLike | null;
}

interface FiberRootLike {
  current: FiberLike;
  containerInfo: unknown;
}

/**
 * Sentinel used to detect React's internal `basicStateReducer`
 * (`useState`'s reducer) by behaviour rather than by reference, since it is
 * not exported from react-dom. `basicStateReducer(state, action)` returns
 * `action` unchanged unless `action` is itself a function (the setter's
 * updater-function form), in which case it calls it. Passing a fresh,
 * non-function sentinel object therefore comes back out unchanged (by
 * identity) if and only if the reducer is `basicStateReducer`. Verified
 * empirically: for a `useState` hook, `reducer(anything, sentinel) ===
 * sentinel`; for a `useReducer` hook with a user reducer, this does not
 * hold (the user reducer computes something else, or throws).
 */
function isBasicStateReducer(reducer: unknown): boolean {
  if (typeof reducer !== "function") return false;
  const sentinel = Symbol("react-fuzzer-probe");
  try {
    return (reducer as (state: unknown, action: unknown) => unknown)(sentinel, sentinel) === sentinel;
  } catch {
    return false;
  }
}

function classifyHook(hook: Hook): { kind: HookKind; value: unknown } {
  const { memoizedState, queue } = hook;

  if (queue) {
    // useState or useReducer: both carry a queue with lastRenderedReducer.
    if (isBasicStateReducer(queue.lastRenderedReducer)) {
      return { kind: "state", value: memoizedState };
    }
    return { kind: "reducer", value: memoizedState };
  }

  // useRef: memoizedState is exactly { current }.
  if (
    memoizedState !== null &&
    typeof memoizedState === "object" &&
    !Array.isArray(memoizedState) &&
    Object.keys(memoizedState).length === 1 &&
    "current" in memoizedState
  ) {
    return { kind: "ref", value: undefined };
  }

  // useEffect / useLayoutEffect: memoizedState is an effect object shaped
  // like { tag, create, deps, next, ... }. Confirmed empirically: `next`
  // points back at itself (a single-entry circular list) for a component
  // with one effect.
  if (
    memoizedState !== null &&
    typeof memoizedState === "object" &&
    !Array.isArray(memoizedState) &&
    "tag" in memoizedState &&
    "create" in memoizedState &&
    "deps" in memoizedState &&
    "next" in memoizedState
  ) {
    return { kind: "effect", value: undefined };
  }

  // useMemo / useCallback: memoizedState is [value, deps]. React does not
  // expose which of the two produced it — both are the exact same
  // two-element-array shape. We distinguish by a heuristic (the cached
  // value is a function => useCallback, since useCallback always caches a
  // function) that is wrong for a useMemo whose computed value happens to
  // be a function; that case falls back to "memo" incorrectly with no way
  // to detect it from fiber state alone. Value is intentionally not
  // captured for either, so the misclassification does not affect M2.
  if (Array.isArray(memoizedState) && memoizedState.length === 2) {
    const [cached] = memoizedState;
    return { kind: typeof cached === "function" ? "callback" : "memo", value: undefined };
  }

  return { kind: "unknown", value: undefined };
}

function extractHooks(fiber: FiberLike): HookRecord[] {
  const hooks: HookRecord[] = [];
  let hook = fiber.memoizedState as Hook | null;
  let index = 0;
  while (hook) {
    const { kind, value } = classifyHook(hook);
    hooks.push({ index, kind, value });
    hook = hook.next;
    index++;
  }
  return hooks;
}

function componentName(fiber: FiberLike): string | null {
  const type = fiber.type;
  if (typeof type === "function") {
    return type.name || "Anonymous";
  }
  return null;
}

/**
 * Walks the fiber tree rooted at `root.current`, collecting every function
 * component's hook list. Only tag-0 FunctionComponent fibers are included;
 * host components, text nodes, fragments and the HostRoot wrapper are
 * skipped. `path` disambiguates multiple instances of the same component by
 * joining the chain of function-component names from the mount root.
 */
export function extractSnapshot(root: OpaqueFiberRoot, commitIndex: number): CommitSnapshot {
  const fiberRoot = root as FiberRootLike;
  const components: ComponentSnapshot[] = [];

  function walk(fiber: FiberLike | null, pathStack: string[]): void {
    if (!fiber) return;

    let nextPathStack = pathStack;
    if (fiber.tag === FUNCTION_COMPONENT_TAG) {
      const name = componentName(fiber);
      if (name) {
        nextPathStack = [...pathStack, name];
        components.push({
          componentName: name,
          path: nextPathStack.join("/"),
          hooks: extractHooks(fiber),
        });
      }
    }

    walk(fiber.child, nextPathStack);
    walk(fiber.sibling, pathStack);
  }

  walk(fiberRoot.current.child, []);

  return { components, commitIndex };
}
