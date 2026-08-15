import type { ExpectedMachine } from "../types.js";

export const expected: ExpectedMachine = {
  component: "FetchList",
  defaultProps:
    "fetchItems is a required function prop with no serialisable default; " +
    "tests supply a mock resolving/rejecting on demand, e.g. () => Promise.resolve([{id:'1',label:'One'}])",
  states: [
    { id: "loading", description: "status === 'loading'; shown on mount and immediately after Retry, before the promise settles" },
    { id: "error", description: "status === 'error'; fetchItems rejected" },
    { id: "empty", description: "status === 'empty'; fetchItems resolved with []" },
    { id: "loaded", description: "status === 'loaded'; fetchItems resolved with >=1 items, list rendered" },
  ],
  transitions: [
    { from: "loading", action: "await settle (fetchItems resolves with items)", to: "loaded" },
    { from: "loading", action: "await settle (fetchItems resolves with [])", to: "empty" },
    { from: "loading", action: "await settle (fetchItems rejects)", to: "error" },
    { from: "error", action: "click Retry", to: "loading" },
    { from: "empty", action: "click Retry", to: "loading" },
  ],
  notes: [
    "There is no user action that leaves 'loaded': once items are shown, the component offers no Retry button, so 'loaded' is a terminal state under interaction alone (only unmount/remount, out of scope, changes it). This is intentional in the component design, not a bug.",
    "'loading' is a single abstract state but is entered twice by different routes (initial mount, and after Retry from either error or empty); hook-value identity alone cannot distinguish 'first load' from 'retry load' since attempt is not rendered, which seems correct: the UI is indistinguishable in both cases.",
    "This is the async-exercising benchmark. The interesting difficulty for an automated explorer is the quiescence/settle detection needed to observe the loading -> {error,empty,loaded} transition reliably, per the M1 exit criterion.",
  ],
};
