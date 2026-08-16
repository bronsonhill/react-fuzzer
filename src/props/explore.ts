/**
 * M4 Deliverable B: multi-assignment exploration and graph merging.
 *
 * Runs a full M3.5 exploreComponent once under the example/default props,
 * then once under each of a set of generated prop assignments, and merges
 * the resulting graphs into a single result per docs/poc-plan.md's
 * provenance rules: states/edges present under the example props keep
 * `default-props` provenance; anything appearing only under a generated
 * assignment is marked `generated-props`, with the responsible assignment
 * recorded on the state's witness (`witness.props`).
 *
 * Props are deliberately NOT folded into state identity -- exploreComponent
 * is called once per assignment, each producing its own graph, and only the
 * *merge* step here combines them. This keeps the state space at "however
 * many distinct hook-value states this component actually has" rather than
 * multiplying it by however many prop assignments were sampled.
 */
import fc from "fast-check";
import { exploreComponent, type ExploreOptions } from "../explore/engine.js";
import type { Edge, ExplorationResult, StateNode } from "../explore/graph.js";

export type AssignmentSource = "example" | "vary-one" | "random";

export interface PropAssignment {
  source: AssignmentSource;
  props: Record<string, unknown>;
  /** Set only for source "vary-one": the single prop key that differs from the example assignment. */
  variedProp?: string;
}

export interface MultiAssignmentOptions extends Omit<ExploreOptions, "props"> {
  /** The developer-supplied example/default prop assignment. Its run keeps default-props provenance. */
  exampleProps: Record<string, unknown>;
  /** Arbitraries for every prop (see propsToArbitraries.ts), used to generate additional assignments. */
  arbitraries: Record<string, fc.Arbitrary<unknown>>;
  /** Number of purely-random assignments to sample, in addition to the one-prop-at-a-time variations. Default 8. */
  sampleCount?: number;
  /** How many alternate values to try per prop for the one-prop-at-a-time pass. Default 2. */
  varyPerProp?: number;
  seed?: number;
}

export interface AssignmentRunResult {
  assignment: PropAssignment;
  result: ExplorationResult;
  /** A canonical hash of this run's state-id set and edge set, used to group assignments by resulting graph shape. */
  shapeHash: string;
}

export interface DistinctShapeGroup {
  shapeHash: string;
  assignments: PropAssignment[];
  stateCount: number;
  edgeCount: number;
  /** true if this is the shape produced by the example props. */
  isExampleShape: boolean;
}

export interface ResponsibleProp {
  prop: string;
  /**
   * "isolated": this prop was the only one varied between two assignments
   * whose shapes differ, so attribution is solid. "correlated": inferred
   * from random samples where exactly one prop happened to differ and the
   * shapes differ too -- weaker evidence, stated as such.
   */
  confidence: "isolated" | "correlated";
  evidence: string;
}

export interface AssignmentBudget {
  assignment: PropAssignment;
  actionsUsed: number;
  statesFound: number;
  elapsedMs: number;
  exhausted: boolean;
}

export interface MultiAssignmentResult {
  /** The merged graph across every assignment run, with provenance per docs/poc-plan.md. */
  merged: ExplorationResult;
  runs: AssignmentRunResult[];
  distinctShapes: DistinctShapeGroup[];
  responsibleProps: ResponsibleProp[];
  budget: {
    perAssignment: AssignmentBudget[];
    aggregate: { actionsUsed: number; statesFound: number; elapsedMs: number; anyExhausted: boolean };
  };
}

/**
 * StateId (`s0`, `s1`, ...) is assigned by a fresh AdaptiveAbstraction
 * instance inside each exploreComponent call, in first-observation order --
 * it is NOT stable across separate exploreComponent invocations (see
 * src/abstraction/adaptive.ts's freshId()). Comparing raw ids across two
 * assignments' runs (for shape hashing, or for merging) would therefore
 * treat two structurally identical states as different just because DFS
 * visited them in a different order. contentKey() is the cross-run-stable
 * substitute: a canonical string of a state's actual hook field values
 * (props parameterise a run but are not part of state identity, per
 * docs/poc-plan.md, so field values alone are the right comparison key).
 */
function contentKey(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .sort()
    .map((k) => `${k}=${JSON.stringify(fields[k])}`)
    .join("|");
}

/** Maps every state id in `result` to its cross-run-stable content key. */
function contentKeyMap(result: ExplorationResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of result.graph.states) map.set(s.id, contentKey(s.fields));
  return map;
}

function edgeContentKey(e: Edge, keyOf: Map<string, string>): string {
  const from = keyOf.get(e.from) ?? e.from;
  const to = keyOf.get(e.to) ?? e.to;
  return `${from}::${to}::${e.kind}::${e.kind === "user" ? e.action?.id : e.driver}`;
}

/** Structural shape hash: content-key state set + content-key edge set, stable across independently-run assignments. */
function shapeHashOf(result: ExplorationResult): string {
  const keyOf = contentKeyMap(result);
  const stateKeys = [...new Set(result.graph.states.map((s) => keyOf.get(s.id)!))].sort();
  const edgeKeys = [...new Set(result.graph.edges.map((e) => edgeContentKey(e, keyOf)))].sort();
  return `states[${stateKeys.join(",")}]|edges[${edgeKeys.join(",")}]`;
}

function buildAssignments(options: MultiAssignmentOptions): PropAssignment[] {
  const assignments: PropAssignment[] = [];
  const seed = options.seed;
  const varyPerProp = options.varyPerProp ?? 2;
  const sampleCount = options.sampleCount ?? 8;

  // One-prop-at-a-time: for each declared prop, hold every other prop at its
  // example value and sample a few alternate values for just this one. This
  // is what lets responsible-prop attribution be solid (isolated) rather
  // than merely correlated, for at least these assignments.
  for (const propName of Object.keys(options.arbitraries)) {
    const arb = options.arbitraries[propName]!;
    const samples = fc.sample(arb, { numRuns: varyPerProp, seed });
    for (const value of samples) {
      assignments.push({
        source: "vary-one",
        variedProp: propName,
        props: { ...options.exampleProps, [propName]: value },
      });
    }
  }

  // Purely random assignments across every prop simultaneously.
  const recordArb = fc.record(options.arbitraries);
  const randomSamples = fc.sample(recordArb, { numRuns: sampleCount, seed });
  for (const props of randomSamples) {
    assignments.push({ source: "random", props: props as Record<string, unknown> });
  }

  return assignments;
}

/**
 * Merges `extra` assignment runs onto `base` (the example-props run).
 * Base states/edges keep `default-props` provenance untouched. Anything
 * from an extra run whose id/edge-key is not already present is added with
 * `generated-props` provenance; the first assignment that produced it is
 * the one recorded on its witness (via witness.props, already part of
 * StateNode -- no schema change needed).
 */
function mergeGraphs(
  base: ExplorationResult,
  extras: Array<{ assignment: PropAssignment; result: ExplorationResult }>,
): ExplorationResult {
  // Canonical (merged) state id -> node, and content-key -> canonical id, so
  // a state with the same hook-field content reached under two different
  // runs collapses to one merged node instead of appearing twice under
  // different raw StateIds (see contentKey()'s doc comment).
  const states = new Map<string, StateNode>();
  const contentToCanonical = new Map<string, string>();
  const edges = new Map<string, Edge>();

  const baseKeyOf = contentKeyMap(base);
  for (const s of base.graph.states) {
    states.set(s.id, s);
    contentToCanonical.set(baseKeyOf.get(s.id)!, s.id);
  }
  for (const e of base.graph.edges) {
    edges.set(edgeContentKey(e, baseKeyOf), e);
  }

  const unavailableActions = [...base.unavailableActions];
  const findings: ExplorationResult["findings"] = {
    unstable: [...base.findings.unstable],
    nonDeterministic: [...base.findings.nonDeterministic],
    replayDivergences: [...base.findings.replayDivergences],
  };
  const rekeyMerges = [...base.rekeyMerges];
  const domPruneReport = [...base.domPruneReport];
  const seenPruneHooks = new Set(domPruneReport.map((e) => e.hookName));
  const demotedHooks = new Set(base.demotedHooks);
  const prunedHooks = new Set(base.prunedHooks);

  extras.forEach(({ assignment, result }, runIndex) => {
    const localKeyOf = contentKeyMap(result);
    // Local (this run's) StateId -> canonical merged id.
    const localToCanonical = new Map<string, string>();
    for (const s of result.graph.states) {
      const ck = localKeyOf.get(s.id)!;
      let canonicalId = contentToCanonical.get(ck);
      if (!canonicalId) {
        // First time this content has been seen anywhere in the merge.
        // Reuse the run's own id unless it collides with an already-used
        // canonical id from a different content key (possible since ids are
        // small per-run counters like "s0", "s1", ...).
        canonicalId = states.has(s.id) ? `gen${runIndex}:${s.id}` : s.id;
        contentToCanonical.set(ck, canonicalId);
        states.set(canonicalId, {
          ...s,
          id: canonicalId,
          key: canonicalId,
          provenance: "generated-props",
          witness: { ...s.witness, props: assignment.props },
        });
      }
      localToCanonical.set(s.id, canonicalId);
    }
    for (const e of result.graph.edges) {
      const from = localToCanonical.get(e.from) ?? e.from;
      const to = localToCanonical.get(e.to) ?? e.to;
      const key = `${from}::${to}::${e.kind}::${e.kind === "user" ? e.action?.id : e.driver}`;
      if (edges.has(key)) continue;
      edges.set(key, { ...e, from, to, provenance: "generated-props" });
    }
    unavailableActions.push(
      ...result.unavailableActions.map((u) => ({ ...u, state: localToCanonical.get(u.state) ?? u.state })),
    );
    findings.unstable.push(
      ...result.findings.unstable.map((e) => ({
        ...e,
        from: localToCanonical.get(e.from) ?? e.from,
        to: localToCanonical.get(e.to) ?? e.to,
      })),
    );
    findings.nonDeterministic.push(
      ...result.findings.nonDeterministic.map((e) => ({
        ...e,
        from: localToCanonical.get(e.from) ?? e.from,
        to: localToCanonical.get(e.to) ?? e.to,
      })),
    );
    findings.replayDivergences.push(...result.findings.replayDivergences);
    rekeyMerges.push(...result.rekeyMerges);
    for (const entry of result.domPruneReport) {
      if (!seenPruneHooks.has(entry.hookName)) {
        seenPruneHooks.add(entry.hookName);
        domPruneReport.push(entry);
      }
    }
    for (const h of result.demotedHooks) demotedHooks.add(h);
    for (const h of result.prunedHooks) prunedHooks.add(h);
  });

  const actionsUsed =
    base.budget.actionsUsed + extras.reduce((n, r) => n + r.result.budget.actionsUsed, 0);
  const elapsedMs =
    base.budget.elapsedMs + extras.reduce((n, r) => n + r.result.budget.elapsedMs, 0);
  const exhausted = base.budget.exhausted || extras.some((r) => r.result.budget.exhausted);

  return {
    component: base.component,
    graph: { states: [...states.values()], edges: [...edges.values()] },
    unavailableActions,
    findings,
    budget: { actionsUsed, statesFound: states.size, elapsedMs, exhausted },
    unexploredFrontier: [
      ...base.unexploredFrontier,
      ...extras.flatMap((r) => r.result.unexploredFrontier),
    ],
    rekeyMerges,
    domPruneReport,
    demotedHooks: [...demotedHooks].sort(),
    prunedHooks: [...prunedHooks].sort(),
  };
}

/**
 * Finds props responsible for a graph-shape change, per docs/poc-plan.md's
 * exit criterion ("the responsible prop assignment is identified"). Two
 * passes: (1) solid attribution from the one-prop-at-a-time runs, where
 * only one prop differs from the example assignment by construction; (2)
 * best-effort attribution from pairs of random assignments that happen to
 * differ in exactly one prop -- explicitly weaker, reported as such.
 */
function findResponsibleProps(
  exampleShapeHash: string,
  runs: AssignmentRunResult[],
): ResponsibleProp[] {
  const found = new Map<string, ResponsibleProp>();

  for (const run of runs) {
    if (run.assignment.source !== "vary-one" || !run.assignment.variedProp) continue;
    if (run.shapeHash === exampleShapeHash) continue;
    const prop = run.assignment.variedProp;
    if (found.has(prop) && found.get(prop)!.confidence === "isolated") continue;
    found.set(prop, {
      prop,
      confidence: "isolated",
      evidence:
        `varying only "${prop}" (to ${JSON.stringify(run.assignment.props[prop])}, ` +
        `all other props held at their example values) changed the graph shape`,
    });
  }

  const randomRuns = runs.filter((r) => r.assignment.source === "random");
  for (let i = 0; i < randomRuns.length; i++) {
    for (let j = i + 1; j < randomRuns.length; j++) {
      const a = randomRuns[i]!;
      const b = randomRuns[j]!;
      if (a.shapeHash === b.shapeHash) continue;
      const keysA = Object.keys(a.assignment.props);
      const differing = keysA.filter(
        (k) => JSON.stringify(a.assignment.props[k]) !== JSON.stringify(b.assignment.props[k]),
      );
      if (differing.length === 1) {
        const prop = differing[0]!;
        if (found.has(prop)) continue; // isolated evidence already covers it
        found.set(prop, {
          prop,
          confidence: "correlated",
          evidence:
            `two random assignments differing only in "${prop}" produced different graph shapes ` +
            `(no other prop happened to differ between them)`,
        });
      }
    }
  }

  return [...found.values()];
}

/**
 * Runs exploreComponent under the example props and under a generated set
 * of prop assignments (one-prop-at-a-time variations plus purely random
 * samples), then merges the resulting graphs with provenance and reports
 * which assignments produced structurally distinct graphs and, where
 * attributable, which prop was responsible.
 */
export async function exploreMultiAssignment(
  options: MultiAssignmentOptions,
): Promise<MultiAssignmentResult> {
  const { exampleProps, arbitraries, sampleCount, varyPerProp, seed, ...exploreOpts } = options;

  const exampleResult = await exploreComponent({ ...exploreOpts, props: exampleProps });
  const exampleAssignment: PropAssignment = { source: "example", props: exampleProps };
  const exampleShapeHash = shapeHashOf(exampleResult);

  const generatedAssignments = buildAssignments(options);

  const runs: AssignmentRunResult[] = [
    { assignment: exampleAssignment, result: exampleResult, shapeHash: exampleShapeHash },
  ];

  for (const assignment of generatedAssignments) {
    const result = await exploreComponent({ ...exploreOpts, props: assignment.props });
    runs.push({ assignment, result, shapeHash: shapeHashOf(result) });
  }

  const extras = runs
    .filter((r) => r.assignment.source !== "example")
    .map((r) => ({ assignment: r.assignment, result: r.result }));
  const merged = mergeGraphs(exampleResult, extras);

  const shapeGroups = new Map<string, DistinctShapeGroup>();
  for (const run of runs) {
    const existing = shapeGroups.get(run.shapeHash);
    if (existing) {
      existing.assignments.push(run.assignment);
    } else {
      shapeGroups.set(run.shapeHash, {
        shapeHash: run.shapeHash,
        assignments: [run.assignment],
        stateCount: run.result.graph.states.length,
        edgeCount: run.result.graph.edges.length,
        isExampleShape: run.shapeHash === exampleShapeHash,
      });
    }
  }

  const responsibleProps = findResponsibleProps(exampleShapeHash, runs);

  const perAssignment: AssignmentBudget[] = runs.map((r) => ({
    assignment: r.assignment,
    actionsUsed: r.result.budget.actionsUsed,
    statesFound: r.result.budget.statesFound,
    elapsedMs: r.result.budget.elapsedMs,
    exhausted: r.result.budget.exhausted,
  }));
  const aggregate = {
    actionsUsed: perAssignment.reduce((n, a) => n + a.actionsUsed, 0),
    statesFound: merged.graph.states.length,
    elapsedMs: perAssignment.reduce((n, a) => n + a.elapsedMs, 0),
    anyExhausted: perAssignment.some((a) => a.exhausted),
  };

  return {
    merged,
    runs,
    distinctShapes: [...shapeGroups.values()],
    responsibleProps,
    budget: { perAssignment, aggregate },
  };
}
