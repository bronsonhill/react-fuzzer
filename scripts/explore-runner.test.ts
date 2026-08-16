/**
 * M5 Deliverable C: the actual CLI work happens here, as a vitest test,
 * because the engine depends on the jsdom environment and on
 * src/fiber/devtoolsHook.ts being imported (and its
 * __REACT_DEVTOOLS_GLOBAL_HOOK__ installed) before react-dom loads --
 * exactly the setup vitest.config.ts + test/setup.ts already provide for
 * every other test file in this repo. Pretending the CLI can run in bare
 * Node without that setup would be dishonest; see README.md's "How to run
 * it" section for the reasoning.
 *
 * src/cli.ts is the actual entry point developers run (`npm run explore --
 * ...`). It parses argv, builds a JSON config, and spawns
 * `vitest run scripts/explore-runner.test.ts` with that config passed via
 * the REACT_FUZZER_CLI_CONFIG environment variable, then exits with the
 * child's exit code. This file reads that env var and does the real work.
 *
 * When REACT_FUZZER_CLI_CONFIG is not set (i.e. `npm test` picked this file
 * up as an ordinary spec), the single test below is skipped -- this file
 * only ever does something when invoked through src/cli.ts.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";

import { exploreComponent } from "../src/explore/engine.js";
import { exploreMultiAssignment } from "../src/props/explore.js";
import { propsToArbitraries } from "../src/props/propsToArbitraries.js";
import { explorationResultToJson, multiAssignmentResultToJson } from "../src/report/json.js";
import { renderExplorationHtml, renderMultiAssignmentHtml } from "../src/report/html.js";
import type { Budget } from "../src/budget.js";

export interface CliConfig {
  /** Absolute path to the component's source module. */
  componentPath: string;
  /** Named export identifying the component function within componentPath. */
  exportName: string;
  /**
   * Absolute path to an optional "example props" module. Its default export
   * (or `config` named export) may provide: exampleProps, propOverrides
   * (prop name -> a small descriptor consulted before inference; see
   * README.md), fillPools, invokableProps, settle, single (boolean: skip
   * prop generation and run one exploreComponent under exampleProps only).
   */
  configPath?: string;
  outJson: string;
  outHtml: string;
  sampleCount?: number;
  varyPerProp?: number;
  seed?: number;
  budget?: Partial<Budget>;
  single?: boolean;
}

interface ExampleConfigModule {
  exampleProps?: Record<string, unknown>;
  /** fast-check arbitraries, keyed by prop name, passed straight to propsToArbitraries as propOverrides. */
  propOverrides?: Record<string, fc.Arbitrary<unknown>>;
  fillPools?: (field: { name: string }) => string[] | undefined;
  invokableProps?: Record<string, (...args: unknown[]) => unknown>;
  settle?: Record<string, unknown>;
  single?: boolean;
  useFakeTimers?: boolean;
}

async function loadConfigModule(configPath: string | undefined): Promise<ExampleConfigModule> {
  if (!configPath) return {};
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: ExampleConfigModule; config?: ExampleConfigModule };
  return mod.default ?? mod.config ?? {};
}

async function run(config: CliConfig): Promise<void> {
  const componentMod = (await import(pathToFileURL(config.componentPath).href)) as Record<string, unknown>;
  const Component = componentMod[config.exportName];
  if (typeof Component !== "function") {
    throw new Error(
      `explore-runner: export "${config.exportName}" not found (or not a function) in ${config.componentPath}. ` +
        `Available exports: ${Object.keys(componentMod).join(", ")}`,
    );
  }

  const exampleConfig = await loadConfigModule(config.configPath);
  const exampleProps = exampleConfig.exampleProps ?? {};
  const single = config.single ?? exampleConfig.single ?? false;

  const render = (props: Record<string, unknown>) => createElement(Component as any, props);

  if (exampleConfig.useFakeTimers) {
    // Fake timers must be installed before exploreComponent/exploreMultiAssignment
    // run (see benchmarks/debounced-search's corpus test for the same pattern);
    // settle() drains them per the settle options below.
    const { vi } = await import("vitest");
    vi.useFakeTimers();
  }

  const budget: Budget | undefined = config.budget
    ? {
        maxActions: config.budget.maxActions ?? 500,
        maxStates: config.budget.maxStates ?? 50,
        maxWallClockMs: config.budget.maxWallClockMs ?? 30_000,
      }
    : undefined;

  const explorationOpts = {
    componentName: config.exportName,
    render,
    sourcePath: config.componentPath,
    fillPools: exampleConfig.fillPools,
    invokableProps: exampleConfig.invokableProps,
    budget,
    settle: exampleConfig.settle as any,
  };

  if (single) {
    const result = await exploreComponent({ ...explorationOpts, props: exampleProps });
    fs.mkdirSync(path.dirname(config.outJson), { recursive: true });
    fs.mkdirSync(path.dirname(config.outHtml), { recursive: true });
    fs.writeFileSync(config.outJson, explorationResultToJson(result));
    fs.writeFileSync(config.outHtml, renderExplorationHtml(result));
    // eslint-disable-next-line no-console
    console.log(`Wrote ${config.outJson} and ${config.outHtml} (${result.graph.states.length} states, single-assignment).`);
    return;
  }

  const { arbitraries } = propsToArbitraries({
    sourcePath: config.componentPath,
    componentName: config.exportName,
    propOverrides: exampleConfig.propOverrides,
  });

  const multi = await exploreMultiAssignment({
    ...explorationOpts,
    exampleProps,
    arbitraries,
    sampleCount: config.sampleCount,
    varyPerProp: config.varyPerProp,
    seed: config.seed,
  });

  fs.mkdirSync(path.dirname(config.outJson), { recursive: true });
  fs.mkdirSync(path.dirname(config.outHtml), { recursive: true });
  fs.writeFileSync(config.outJson, multiAssignmentResultToJson(multi));
  fs.writeFileSync(config.outHtml, renderMultiAssignmentHtml(multi));
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${config.outJson} and ${config.outHtml} (${multi.merged.graph.states.length} merged states across ${multi.runs.length} prop assignments).`,
  );
}

const rawConfig = process.env.REACT_FUZZER_CLI_CONFIG;

describe("explore-runner (driven by src/cli.ts)", () => {
  it.skipIf(!rawConfig)("runs the configured exploration and writes the JSON/HTML artefacts", async () => {
    const config = JSON.parse(rawConfig as string) as CliConfig;
    await run(config);
    expect(fs.existsSync(config.outJson)).toBe(true);
    expect(fs.existsSync(config.outHtml)).toBe(true);
  });
});
