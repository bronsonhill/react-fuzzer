#!/usr/bin/env node
/**
 * M5 Deliverable C: CLI entry point.
 *
 * `npm run explore -- --component <path> --export <Name> ...`
 *
 * The exploration engine needs the jsdom environment and
 * src/fiber/devtoolsHook.ts's __REACT_DEVTOOLS_GLOBAL_HOOK__ installed
 * before react-dom loads (see test/setup.ts). Vitest already provides
 * exactly that setup for every test file in this repo, so rather than
 * reimplementing jsdom bootstrapping and import-order-sensitive hook
 * installation in bare Node, this CLI is a thin argv-parsing wrapper that
 * spawns `vitest run scripts/explore-runner.test.ts`, passing the parsed
 * config through the REACT_FUZZER_CLI_CONFIG environment variable, and
 * exits with the child process's exit code. See scripts/explore-runner.test.ts
 * for where the actual exploration and file-writing happens.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ParsedArgs {
  command: "explore" | "approve" | "diff";
  component?: string;
  export?: string;
  config?: string;
  outJson?: string;
  outHtml?: string;
  sampleCount?: number;
  varyPerProp?: number;
  seed?: number;
  maxActions?: number;
  maxStates?: number;
  maxWallClockMs?: number;
  single?: boolean;
  expanded?: boolean;
  previewCss?: string;
  baseline?: string;
  help?: boolean;
}

const HELP = `
react-fuzzer -- generate, approve, and diff state-graph reports for a React component.

Usage:
  npm run explore -- [explore|approve|diff] --component <path/to/Component.tsx> --export <ExportName> [options]

  The subcommand defaults to "explore" if omitted (backwards compatible with
  the M5 CLI).

Required:
  --component <path>   Path to the component's source module (.tsx/.ts).
  --export <name>       Named export identifying the component function.

Optional (all subcommands):
  --config <path>       Path to a module whose default export configures the
                         run: { exampleProps, propOverrides, fillPools,
                         invokableProps, settle, useFakeTimers, single }.
                         See README.md for the shape and an example.
  --sample-count <n>    Random prop assignments to sample (multi-assignment mode).
  --vary-per-prop <n>   Alternate values tried per prop, one at a time.
  --seed <n>             fast-check sampling seed, for reproducible runs.
  --max-actions <n>     Budget override: max actions per run.
  --max-states <n>      Budget override: max states per run.
  --max-wall-clock-ms <n>  Budget override: wall-clock ceiling per run.
  --single               Skip prop generation; run once under exampleProps
                         only (default-props provenance only).
  -h, --help             Show this help.

explore-only:
  --out-json <path>     Output path for the JSON artefact. Default: examples/<export>.json
  --out-html <path>     Output path for the HTML report. Default: examples/<export>.html
  --expanded             Disable M6's transient-async-chain collapse in the
                         HTML diagram (default: collapsed). The JSON artefact
                         and state table are always full-fidelity regardless
                         of this flag.
  --preview-css <path>  Stylesheet to inline into each state preview in the
                         HTML report. Exploration runs under jsdom, which
                         loads no CSS, so previews are unstyled unless this
                         (or the config module's previewStylesheet) points at
                         the component's compiled CSS.

approve-only:
  --out-json <path>     Output path for the baseline file.
                         Default: examples/baselines/<export>.baseline.json

diff-only:
  --baseline <path>     Path to the baseline file to diff against.
                         Default: examples/baselines/<export>.baseline.json
                         Exits non-zero (excluding abstraction-churn-only
                         diffs) when differences are found -- CI-usable.
`;

function parseArgs(argv: string[]): ParsedArgs {
  let rest = argv;
  let command: ParsedArgs["command"] = "explore";
  if (rest[0] === "explore" || rest[0] === "approve" || rest[0] === "diff") {
    command = rest[0];
    rest = rest.slice(1);
  }
  const args: ParsedArgs = { command };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    switch (a) {
      case "--component": args.component = next(); break;
      case "--export": args.export = next(); break;
      case "--config": args.config = next(); break;
      case "--out-json": args.outJson = next(); break;
      case "--out-html": args.outHtml = next(); break;
      case "--sample-count": args.sampleCount = Number(next()); break;
      case "--vary-per-prop": args.varyPerProp = Number(next()); break;
      case "--seed": args.seed = Number(next()); break;
      case "--max-actions": args.maxActions = Number(next()); break;
      case "--max-states": args.maxStates = Number(next()); break;
      case "--max-wall-clock-ms": args.maxWallClockMs = Number(next()); break;
      case "--single": args.single = true; break;
      case "--expanded": args.expanded = true; break;
      case "--preview-css": args.previewCss = next(); break;
      case "--baseline": args.baseline = next(); break;
      case "-h":
      case "--help": args.help = true; break;
      default:
        throw new Error(`Unrecognised argument: ${a}`);
    }
  }
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.component || !args.export) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const componentPath = path.resolve(process.cwd(), args.component);
  const configPath = args.config ? path.resolve(process.cwd(), args.config) : undefined;
  const defaultBaselinePath = path.join(repoRoot, "examples", "baselines", `${args.export}.baseline.json`);
  const outJson = path.resolve(
    process.cwd(),
    args.outJson ?? (args.command === "approve" ? defaultBaselinePath : path.join(repoRoot, "examples", `${args.export}.json`)),
  );
  const outHtml = path.resolve(process.cwd(), args.outHtml ?? path.join(repoRoot, "examples", `${args.export}.html`));
  const baselinePath = path.resolve(process.cwd(), args.baseline ?? defaultBaselinePath);

  const budget =
    args.maxActions !== undefined || args.maxStates !== undefined || args.maxWallClockMs !== undefined
      ? { maxActions: args.maxActions, maxStates: args.maxStates, maxWallClockMs: args.maxWallClockMs }
      : undefined;

  const config = {
    command: args.command,
    componentPath,
    exportName: args.export,
    configPath,
    outJson,
    outHtml,
    baselinePath,
    sampleCount: args.sampleCount,
    varyPerProp: args.varyPerProp,
    seed: args.seed,
    budget,
    single: args.single,
    collapse: !args.expanded,
    previewCssPath: args.previewCss ? path.resolve(process.cwd(), args.previewCss) : undefined,
  };

  const runnerPath = path.join(repoRoot, "scripts", "explore-runner.test.ts");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      runnerPath,
      "--root",
      repoRoot,
      "--reporter=verbose",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, REACT_FUZZER_CLI_CONFIG: JSON.stringify(config) },
    },
  );
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

process.exit(main());
