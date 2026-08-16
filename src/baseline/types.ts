/**
 * M6 Part 2: baseline schema. A baseline is a checked-in snapshot of a
 * component's explored graph plus developer-supplied names, written by the
 * `approve` CLI subcommand (src/cli.ts) and compared against by `diff`.
 *
 * State identity across separate exploration runs cannot be the engine's
 * internal StateId ("s0", "s1", ...): those are assigned in first-observation
 * order within one exploreComponent call and are not stable run to run (see
 * src/props/explore.ts's contentKey doc comment, which hits the identical
 * problem merging assignments within one run). A baseline instead keys each
 * state by `computeStateKeyForFields` (src/abstraction/adaptive.ts) applied
 * to that state's recorded hook fields under the *abstraction rules in force
 * at approval time* (abstractionConfig.demotedHooks/prunedHooks below). This
 * is exactly what a later diff run needs to recompute under its own
 * (possibly different) rules to detect abstraction churn -- see
 * src/baseline/diff.ts.
 */
import type { Provenance, EdgeKind, AutoDriver } from "../explore/graph.js";

export const BASELINE_SCHEMA_VERSION = 1;

export interface BaselineAbstractionConfig {
  /** literalDomainLimit in force when this baseline was approved (see AdaptiveOptions). */
  literalDomainLimit: number;
  domCorrelationEnabled: boolean;
  domCorrelationMinObservations: number;
  ignoreHooks: string[];
  /** Hooks demoted to bucketed canonicalisation by the time this baseline was approved. */
  demotedHooks: string[];
  /** Hooks excluded from state identity by the DOM-correlation pruner by the time this baseline was approved. */
  prunedHooks: string[];
}

export interface BaselineState {
  /** Cross-run-stable key: computeStateKeyForFields(fields, {demotedHooks, prunedHooks}) using this baseline's own abstractionConfig. */
  key: string;
  /**
   * Developer-supplied readable name. Auto-generated at approve time from
   * the state's fields (e.g. "value=3, running=true"); renaming this IS the
   * approval act (see docs/poc-plan.md's M6 section) -- the file is meant to
   * be hand-edited afterwards.
   */
  name: string;
  provenance: Provenance;
  transient: boolean;
  fields: Record<string, unknown>;
}

export interface BaselineTransition {
  /** Baseline state key (not name -- names can be freely edited without breaking the diff). */
  from: string;
  to: string;
  kind: EdgeKind;
  actionId?: string;
  actionLabel?: string;
  driver?: AutoDriver;
  provenance: Provenance;
  stable: boolean;
}

export interface Baseline {
  schemaVersion: number;
  component: string;
  generatedAt: string;
  abstractionConfig: BaselineAbstractionConfig;
  states: BaselineState[];
  transitions: BaselineTransition[];
}
