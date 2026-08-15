// Must be imported first, before any module that transitively imports
// react-dom (including @testing-library/jest-dom below is fine — jest-dom
// only extends `expect` and doesn't import react-dom — but this ordering is
// deliberately kept first regardless, since react-dom checks for
// __REACT_DEVTOOLS_GLOBAL_HOOK__ exactly once at its own module init).
import "../src/fiber/devtoolsHook.js";
import "@testing-library/jest-dom/vitest";
