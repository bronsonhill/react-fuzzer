import type { ExpectedMachine } from "../types.js";

export const expected: ExpectedMachine = {
  component: "DebouncedSearch",
  defaultProps:
    "query is a required function prop with no serialisable default; " +
    "tests supply a mock resolving/rejecting on demand. debounceMs defaults to 300.",
  states: [
    { id: "idle", description: "phase === 'idle'; input empty or cleared, 'Type to search' shown" },
    { id: "waiting", description: "phase === 'waiting'; keystroke registered, debounce timer running, query not yet fired" },
    { id: "searching", description: "phase === 'searching'; debounce elapsed, query() called, promise pending" },
    { id: "results", description: "phase === 'results'; query resolved with >=1 result" },
    { id: "no-results", description: "phase === 'no-results'; query resolved with []" },
    { id: "error", description: "phase === 'error'; query rejected" },
  ],
  transitions: [
    { from: "idle", action: "type non-whitespace character", to: "waiting" },
    { from: "waiting", action: "type another character before debounce elapses", to: "waiting", note: "timer is reset; still collapses to the same abstract state" },
    { from: "waiting", action: "clear input before debounce elapses", to: "idle" },
    { from: "waiting", action: "advance clock by debounceMs", to: "searching" },
    { from: "searching", action: "await settle (query resolves with results)", to: "results" },
    { from: "searching", action: "await settle (query resolves with [])", to: "no-results" },
    { from: "searching", action: "await settle (query rejects)", to: "error" },
    { from: "results", action: "clear input", to: "idle" },
    { from: "results", action: "type another character", to: "waiting" },
    { from: "no-results", action: "clear input", to: "idle" },
    { from: "no-results", action: "type another character", to: "waiting" },
    { from: "error", action: "clear input", to: "idle" },
    { from: "error", action: "type another character", to: "waiting" },
  ],
  notes: [
    "This is the deliberately awkward benchmark: 'waiting' and 'searching' are not distinguishable by any state a naive DOM-diff would catch reliably without controlling the clock, since both render short static text and the interesting event (the setTimeout firing, the query() call happening) is invisible without fake timers under the explorer's control. This directly tests the M1 quiescence/settle-loop requirement.",
    "A keystroke while already 'waiting' resets the debounce timer but does not change phase, so it is listed as a self-loop; this only matters for a real explorer's timing model, not for the state graph shape.",
    "requestId ref-based stale-response guarding means an in-flight request from a previous keystroke can resolve after being superseded and is correctly ignored (myId !== requestId.current); this book-keeping is invisible in the exported state machine since it never produces an observable state by itself, but it is exactly the kind of behaviour that would be silently wrong if an explorer didn't fully drain timers between actions.",
    "phase is stored as its own hook rather than derived, so it is the correct unit of state identity here; text content is abstracted per the plan's non-empty/empty string rule and does not otherwise affect identity.",
  ],
};
