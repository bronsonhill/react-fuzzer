/**
 * M6 Part 2: builds a Baseline (./types.ts) from a fresh ExplorationResult.
 * Used by the `approve` CLI subcommand.
 */
import { computeStateKeyForFields } from "../abstraction/adaptive.js";
import type { ExplorationResult, StateNode } from "../explore/graph.js";
import { BASELINE_SCHEMA_VERSION, type Baseline, type BaselineAbstractionConfig, type BaselineState, type BaselineTransition } from "./types.js";

export interface BuildBaselineOptions {
  /** literalDomainLimit used for this run; default matches AdaptiveOptions' own default (8) since the runner doesn't always pass one explicitly. */
  literalDomainLimit?: number;
  domCorrelationEnabled?: boolean;
  domCorrelationMinObservations?: number;
  ignoreHooks?: string[];
}

function slug(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_.=\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Auto-generates a readable default name for a state from its fields, e.g. "value=3_running=true". Falls back to "initial" for the no-field (mount) state. */
function readableName(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) return "initial";
  const parts = keys.map((k) => {
    let v: string;
    try {
      v = JSON.stringify(fields[k]);
    } catch {
      v = String(fields[k]);
    }
    return `${k}=${v}`;
  });
  return slug(parts.join(", ")) || "state";
}

function dedupeName(base: string, used: Map<string, number>): string {
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}_${count}`;
}

export function buildBaseline(result: ExplorationResult, opts: BuildBaselineOptions = {}): Baseline {
  const abstractionConfig: BaselineAbstractionConfig = {
    literalDomainLimit: opts.literalDomainLimit ?? 8,
    domCorrelationEnabled: opts.domCorrelationEnabled ?? true,
    domCorrelationMinObservations: opts.domCorrelationMinObservations ?? 3,
    ignoreHooks: [...(opts.ignoreHooks ?? [])].sort(),
    demotedHooks: [...result.demotedHooks].sort(),
    prunedHooks: [...result.prunedHooks].sort(),
  };

  const keyOf = new Map<string, string>(); // raw StateId -> baseline key
  const usedNames = new Map<string, number>();
  const states: BaselineState[] = [];

  const sortedStates = [...result.graph.states].sort((a, b) => a.key.localeCompare(b.key));
  for (const s of sortedStates as StateNode[]) {
    const key = computeStateKeyForFields(s.fields, {
      demotedHooks: abstractionConfig.demotedHooks,
      prunedHooks: abstractionConfig.prunedHooks,
      ignoreHooks: abstractionConfig.ignoreHooks,
    });
    keyOf.set(s.id, key);
    states.push({
      key,
      name: dedupeName(readableName(s.fields), usedNames),
      provenance: s.provenance,
      transient: s.transient ?? false,
      fields: s.fields,
    });
  }

  const transitions: BaselineTransition[] = result.graph.edges.map((e) => ({
    from: keyOf.get(e.from) ?? e.from,
    to: keyOf.get(e.to) ?? e.to,
    kind: e.kind,
    ...(e.kind === "user" ? { actionId: e.action?.id, actionLabel: e.action?.label } : { driver: e.driver }),
    provenance: e.provenance,
    stable: e.stable,
  }));

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    component: result.component,
    generatedAt: new Date().toISOString(),
    abstractionConfig,
    states: states.sort((a, b) => a.key.localeCompare(b.key)),
    transitions: transitions.sort((a, b) => `${a.from}::${a.actionId ?? a.driver}::${a.to}`.localeCompare(`${b.from}::${b.actionId ?? b.driver}::${b.to}`)),
  };
}
