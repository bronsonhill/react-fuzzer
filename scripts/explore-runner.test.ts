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
import { buildBaseline } from "../src/baseline/build.js";
import { diffAgainstBaseline, type DiffReport } from "../src/baseline/diff.js";
import type { Baseline } from "../src/baseline/types.js";
import type { Budget } from "../src/budget.js";
import type { ExplorationResult } from "../src/explore/graph.js";

export interface CliConfig {
  command?: "explore" | "approve" | "diff";
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
  baselinePath?: string;
  sampleCount?: number;
  varyPerProp?: number;
  seed?: number;
  budget?: Partial<Budget>;
  single?: boolean;
  collapse?: boolean;
  /** Absolute path to a stylesheet inlined into each state preview in the HTML report. */
  previewCssPath?: string;
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
  /** Path (absolute, or relative to cwd) to a stylesheet to inline into the HTML report's state previews. */
  previewStylesheet?: string;
}

async function loadConfigModule(configPath: string | undefined): Promise<ExampleConfigModule> {
  if (!configPath) return {};
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: ExampleConfigModule; config?: ExampleConfigModule };
  return mod.default ?? mod.config ?? {};
}

/** Runs the configured exploration (single- or multi-assignment) and returns both the merged ExplorationResult and, for explore/approve, whatever else the caller needs to render. */
async function runExploration(config: CliConfig): Promise<{ result: ExplorationResult; writeExplore: () => void }> {
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

  const collapse = config.collapse ?? true;

  // Previews are captured markup rendered under jsdom, which loads no CSS.
  // A stylesheet here (CLI flag, else config module) is inlined into each
  // preview iframe so class names get their rules back; without one,
  // previews are structurally accurate and visually plain.
  const previewCssPath = config.previewCssPath ?? (exampleConfig.previewStylesheet ? path.resolve(process.cwd(), exampleConfig.previewStylesheet) : undefined);
  const previewStylesheet = previewCssPath ? fs.readFileSync(previewCssPath, "utf8") : undefined;

  if (single) {
    const result = await exploreComponent({ ...explorationOpts, props: exampleProps });
    return {
      result,
      writeExplore: () => {
        fs.mkdirSync(path.dirname(config.outJson), { recursive: true });
        fs.mkdirSync(path.dirname(config.outHtml), { recursive: true });
        fs.writeFileSync(config.outJson, explorationResultToJson(result));
        fs.writeFileSync(config.outHtml, renderExplorationHtml(result, { collapseTransientChains: collapse, previewStylesheet }));
        // eslint-disable-next-line no-console
        console.log(`Wrote ${config.outJson} and ${config.outHtml} (${result.graph.states.length} states, single-assignment).`);
      },
    };
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

  return {
    result: multi.merged,
    writeExplore: () => {
      fs.mkdirSync(path.dirname(config.outJson), { recursive: true });
      fs.mkdirSync(path.dirname(config.outHtml), { recursive: true });
      fs.writeFileSync(config.outJson, multiAssignmentResultToJson(multi));
      fs.writeFileSync(config.outHtml, renderMultiAssignmentHtml(multi, { collapseTransientChains: collapse, previewStylesheet }));
      // eslint-disable-next-line no-console
      console.log(
        `Wrote ${config.outJson} and ${config.outHtml} (${multi.merged.graph.states.length} merged states across ${multi.runs.length} prop assignments).`,
      );
    },
  };
}

function printDiffReport(report: DiffReport): void {
  const lines: string[] = [`Diff report for ${report.component}:`];
  const section = (title: string, items: unknown[], fmt: (i: any) => string) => {
    lines.push(`  ${title}: ${items.length}`);
    for (const i of items) lines.push(`    - ${fmt(i)}`);
  };
  section("new states", report.newStates, (s) => `${s.key}`);
  section("lost states", report.lostStates, (s) => `${s.name ?? "?"} (${s.key})`);
  section("abstraction churn merges (NOT regressions)", report.abstractionChurnMerges, (m) =>
    `${m.mergedBaselineStates.map((s: any) => s.name).join(" + ")} -> ${m.recomputedKey}: ${m.reason}`,
  );
  section("new transitions", report.newTransitions, (t) => `${t.from} --${t.action}--> ${t.to}`);
  section("lost transitions", report.lostTransitions, (t) => `${t.from} --${t.action}--> ${t.to}`);
  section("provenance changes", report.provenanceChanges, (p) => `${p.name} (${p.key}): ${p.from} -> ${p.to}`);
  section("stability changes", report.stabilityChanges, (s) => `${s.from} --${s.action}--> ${s.to}: stable ${s.baselineStable} -> ${s.currentStable}`);
  lines.push(`  hasDifferences: ${report.hasDifferences}`);
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

async function run(config: CliConfig): Promise<void> {
  const command = config.command ?? "explore";

  if (command === "explore") {
    const { writeExplore } = await runExploration(config);
    writeExplore();
    return;
  }

  if (command === "approve") {
    const { result } = await runExploration(config);
    const baseline = buildBaseline(result);
    fs.mkdirSync(path.dirname(config.outJson), { recursive: true });
    fs.writeFileSync(config.outJson, JSON.stringify(baseline, null, 2) + "\n");
    // eslint-disable-next-line no-console
    console.log(
      `Approved baseline ${config.outJson}: ${baseline.states.length} states, ${baseline.transitions.length} transitions. ` +
        `Rename states in the file to record developer approval of their identity.`,
    );
    return;
  }

  // diff
  const baselinePath = config.baselinePath ?? config.outJson;
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`explore-runner diff: no baseline found at ${baselinePath}. Run \`approve\` first.`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
  const { result } = await runExploration(config);
  const report = diffAgainstBaseline(baseline, result);
  printDiffReport(report);
  // Exit non-zero (via a failing assertion, which fails the vitest run
  // src/cli.ts spawns and propagates as CLI exit code) exactly when there
  // are real differences. Abstraction-churn-only merges are, by design
  // (see src/baseline/diff.ts), NOT counted in hasDifferences, so a
  // demotion-driven merge alone does not fail this diff.
  expect(report.hasDifferences, JSON.stringify(report, null, 2)).toBe(false);
}

const rawConfig = process.env.REACT_FUZZER_CLI_CONFIG;

describe("explore-runner (driven by src/cli.ts)", () => {
  it.skipIf(!rawConfig)("runs the configured command (explore/approve/diff)", async () => {
    const config = JSON.parse(rawConfig as string) as CliConfig;
    await run(config);
    if ((config.command ?? "explore") !== "diff") {
      expect(fs.existsSync(config.outJson)).toBe(true);
    }
  });
});
