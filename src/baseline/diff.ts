/**
 * M6 Part 2 + 3: diffs a fresh ExplorationResult against a checked-in
 * Baseline (./types.ts). Used by the `diff` CLI subcommand.
 *
 * The single most important correctness requirement (per docs/poc-plan.md's
 * M6 section and docs/m2-5-adaptive-report.md's rekey/demotion section) is
 * NOT reporting abstraction churn as a regression: exploration can cross a
 * hook's literalDomainLimit (or newly qualify a hook for DOM-correlation
 * pruning) mid-run, retroactively merging what were, until that point, two
 * distinct state ids. If a baseline was approved before that demotion
 * happened (or under a different literalDomainLimit), a later unchanged-
 * component run can legitimately produce FEWER distinct states than the
 * baseline -- not because the component regressed, but because the
 * abstraction now groups two of the baseline's states together. Reporting
 * that as "2 lost states" would be exactly the spurious-diff failure mode
 * that would make this tool useless (see the M6 task's explicit warning).
 *
 * The fix: recompute each baseline state's key under the CURRENT run's
 * demoted/pruned hook sets (computeStateKeyForFields, applied to the
 * baseline's stored `fields` snapshot). If two or more baseline states
 * recompute to the same key, that is reported as an "abstraction churn
 * merge" -- named, evidenced, and kept entirely separate from "lost state".
 * A baseline state is only a genuine lost state if, after this recompute,
 * its key still does not match any current state's key.
 *
 * Documented ambiguity (see docs/m6-baseline-report.md for the fuller
 * writeup): a baseline state's `fields` is a single representative
 * snapshot captured at approval time, not the full set of raw values that
 * may have been folded into it even at that point (mirroring how the
 * exploration engine itself only keeps one representative field set per
 * merged StateNode -- see src/explore/engine.ts's onRekey handler). If the
 * baseline run's own demotion had already merged several raw literal values
 * into one state before approval, recomputing that single stored snapshot
 * under a later run's rules cannot distinguish "this merge is still valid"
 * from "this exact literal value no longer occurs, but siblings that also
 * fed into this baseline state might still exist" -- the diff can only ever
 * reason about the one snapshot it has. This is a real, acknowledged gap: a
 * demotion that happened *before* baseline approval and again differently
 * *after* it, on a component with 3+ raw values into one bucket, is not
 * fully reconstructible from the baseline file alone.
 */
import { computeStateKeyForFields } from "../abstraction/adaptive.js";
import type { ExplorationResult, Provenance } from "../explore/graph.js";
import type { Baseline, BaselineState } from "./types.js";

export interface StateDiffEntry {
  key: string;
  name?: string; // baseline name, when known
}

export interface AbstractionChurnMerge {
  /** Baseline states (name + key) that now recompute to the same key under the current run's abstraction rules. */
  mergedBaselineStates: Array<{ key: string; name: string }>;
  /** The key they now share. */
  recomputedKey: string;
  reason: string;
}

export interface ProvenanceChange {
  key: string;
  name: string;
  from: Provenance;
  to: Provenance;
}

export interface TransitionDiffEntry {
  from: string;
  to: string;
  action: string;
}

export interface StabilityChange {
  from: string;
  to: string;
  action: string;
  baselineStable: boolean;
  currentStable: boolean;
}

export interface DiffReport {
  component: string;
  newStates: StateDiffEntry[];
  lostStates: StateDiffEntry[];
  abstractionChurnMerges: AbstractionChurnMerge[];
  newTransitions: TransitionDiffEntry[];
  lostTransitions: TransitionDiffEntry[];
  provenanceChanges: ProvenanceChange[];
  stabilityChanges: StabilityChange[];
  /** True if any of the above (except abstractionChurnMerges, which is explicitly not a regression signal) is non-empty. */
  hasDifferences: boolean;
}

function currentAbstractionRules(current: ExplorationResult) {
  return { demotedHooks: current.demotedHooks, prunedHooks: current.prunedHooks, ignoreHooks: [] as string[] };
}

function transitionKey(from: string, to: string, action: string): string {
  return `${from}::${action}::${to}`;
}

export function diffAgainstBaseline(baseline: Baseline, current: ExplorationResult): DiffReport {
  const rules = currentAbstractionRules(current);

  // Recompute each baseline state's key under the current run's rules.
  const recomputed = baseline.states.map((s) => ({
    baseline: s,
    recomputedKey: computeStateKeyForFields(s.fields, rules),
  }));

  // Group by recomputed key to find abstraction-churn merges.
  const byRecomputedKey = new Map<string, BaselineState[]>();
  for (const r of recomputed) {
    const arr = byRecomputedKey.get(r.recomputedKey) ?? [];
    arr.push(r.baseline);
    byRecomputedKey.set(r.recomputedKey, arr);
  }
  const abstractionChurnMerges: AbstractionChurnMerge[] = [];
  for (const [recomputedKey, states] of byRecomputedKey) {
    if (states.length > 1) {
      abstractionChurnMerges.push({
        recomputedKey,
        mergedBaselineStates: states.map((s) => ({ key: s.key, name: s.name })),
        reason:
          `these ${states.length} baseline states now compute to the same state key under the current run's ` +
          `abstraction rules (demoted hooks: [${current.demotedHooks.join(", ") || "none"}], pruned hooks: ` +
          `[${current.prunedHooks.join(", ") || "none"}]) -- reported as abstraction churn, not a regression. ` +
          `See src/baseline/diff.ts's module doc comment for the documented limits of this detection.`,
      });
    }
  }

  // Baseline recomputed-key -> representative baseline state (first, by original key order) for naming.
  const baselineKeyToRepresentative = new Map<string, BaselineState>();
  for (const r of recomputed) {
    if (!baselineKeyToRepresentative.has(r.recomputedKey)) baselineKeyToRepresentative.set(r.recomputedKey, r.baseline);
  }
  const baselineRecomputedKeys = new Set(recomputed.map((r) => r.recomputedKey));

  // Current states' keys, using the SAME computeStateKeyForFields recompute
  // (rather than raw StateId) so the comparison space is uniform. Current
  // states are already deduplicated by the run's own abstraction, so this
  // is expected to be idempotent, but recomputing keeps the key format
  // identical to the baseline side.
  const currentKeyOfStateId = new Map<string, string>();
  for (const s of current.graph.states) {
    currentKeyOfStateId.set(s.id, computeStateKeyForFields(s.fields, rules));
  }
  const currentKeys = new Set(currentKeyOfStateId.values());
  const currentKeyToState = new Map<string, (typeof current.graph.states)[number]>();
  for (const s of current.graph.states) {
    const k = currentKeyOfStateId.get(s.id)!;
    if (!currentKeyToState.has(k)) currentKeyToState.set(k, s);
  }

  const newStates: StateDiffEntry[] = [...currentKeys]
    .filter((k) => !baselineRecomputedKeys.has(k))
    .map((k) => ({ key: k }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const lostStates: StateDiffEntry[] = [...baselineRecomputedKeys]
    .filter((k) => !currentKeys.has(k))
    .map((k) => ({ key: k, name: baselineKeyToRepresentative.get(k)?.name }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Provenance changes: states present (by recomputed key) in both. Keys
  // involved in an abstraction-churn merge are deliberately EXCLUDED here:
  // when several baseline states collapse onto one recomputed key, which of
  // them is picked as "the" representative (for comparing provenance) is an
  // arbitrary artefact of iteration order, not a meaningful comparison --
  // reporting a provenance "change" there would just be restating the
  // abstraction-churn merge under a different, misleading label. This is
  // the ambiguity flagged in this module's doc comment.
  const churnedKeys = new Set(abstractionChurnMerges.map((m) => m.recomputedKey));
  const provenanceChanges: ProvenanceChange[] = [];
  for (const k of baselineRecomputedKeys) {
    if (!currentKeys.has(k)) continue;
    if (churnedKeys.has(k)) continue;
    const baselineRep = baselineKeyToRepresentative.get(k)!;
    const currentState = currentKeyToState.get(k)!;
    if (baselineRep.provenance !== currentState.provenance) {
      provenanceChanges.push({ key: k, name: baselineRep.name, from: baselineRep.provenance, to: currentState.provenance });
    }
  }

  // Transitions, recomputed onto the same key space.
  const baselineTransitionKeys = new Map<string, { stable: boolean }>();
  for (const t of baseline.transitions) {
    // Baseline transitions were stored keyed by original baseline key; remap
    // endpoints through the recompute so a churn-merged endpoint compares
    // correctly against the current graph.
    const fromRec = recomputed.find((r) => r.baseline.key === t.from)?.recomputedKey ?? t.from;
    const toRec = recomputed.find((r) => r.baseline.key === t.to)?.recomputedKey ?? t.to;
    const action = t.kind === "user" ? (t.actionId ?? "action") : `auto:${t.driver ?? "?"}`;
    baselineTransitionKeys.set(transitionKey(fromRec, toRec, action), { stable: t.stable });
  }
  const currentTransitionKeys = new Map<string, { stable: boolean }>();
  for (const e of current.graph.edges) {
    const from = currentKeyOfStateId.get(e.from) ?? e.from;
    const to = currentKeyOfStateId.get(e.to) ?? e.to;
    const action = e.kind === "user" ? (e.action?.id ?? "action") : `auto:${e.driver ?? "?"}`;
    currentTransitionKeys.set(transitionKey(from, to, action), { stable: e.stable });
  }

  // Same exclusion as provenanceChanges above: a transition touching a
  // churned endpoint compares an arbitrary representative, not a meaningful
  // fact about the component, so it's excluded from new/lost/stability
  // reporting rather than reported as a possibly-spurious change.
  const touchesChurn = (k: string) => {
    const entry = keyToEntry(k);
    return churnedKeys.has(entry.from) || churnedKeys.has(entry.to);
  };

  const newTransitions: TransitionDiffEntry[] = [...currentTransitionKeys.keys()]
    .filter((k) => !baselineTransitionKeys.has(k) && !touchesChurn(k))
    .map(keyToEntry)
    .sort(sortEntries);
  const lostTransitions: TransitionDiffEntry[] = [...baselineTransitionKeys.keys()]
    .filter((k) => !currentTransitionKeys.has(k) && !touchesChurn(k))
    .map(keyToEntry)
    .sort(sortEntries);

  const stabilityChanges: StabilityChange[] = [];
  for (const [k, baselineInfo] of baselineTransitionKeys) {
    if (touchesChurn(k)) continue;
    const currentInfo = currentTransitionKeys.get(k);
    if (!currentInfo) continue;
    if (baselineInfo.stable !== currentInfo.stable) {
      const entry = keyToEntry(k);
      stabilityChanges.push({ ...entry, baselineStable: baselineInfo.stable, currentStable: currentInfo.stable });
    }
  }

  const hasDifferences =
    newStates.length > 0 ||
    lostStates.length > 0 ||
    newTransitions.length > 0 ||
    lostTransitions.length > 0 ||
    provenanceChanges.length > 0 ||
    stabilityChanges.length > 0;

  return {
    component: current.component,
    newStates,
    lostStates,
    abstractionChurnMerges,
    newTransitions,
    lostTransitions,
    provenanceChanges,
    stabilityChanges,
    hasDifferences,
  };
}

function keyToEntry(k: string): TransitionDiffEntry {
  const [from, action, to] = k.split("::");
  return { from: from ?? k, action: action ?? "", to: to ?? "" };
}

function sortEntries(a: TransitionDiffEntry, b: TransitionDiffEntry): number {
  return `${a.from}::${a.action}::${a.to}`.localeCompare(`${b.from}::${b.action}::${b.to}`);
}
