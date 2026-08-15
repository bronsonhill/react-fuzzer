/**
 * M2: state abstraction. Turns a ComponentSnapshot's hook values into a
 * StateKey — a deterministic identity for "what state is this component in"
 * that is stable under a benign hook reorder or an inserted unrelated hook,
 * because identity is keyed by name (recovered statically, see
 * ./hookNames.ts) rather than by raw hook index.
 */
import type { ComponentSnapshot, HookRecord } from "../fiber/index.js";
import { canonicalise, stableStringify, type CanonToken } from "./canonicalise.js";
import { getHookNames } from "./hookNames.js";

export interface StateKey {
  key: string;
  fields: Record<string, unknown>;
}

export interface AbstractionOptions {
  componentName: string;
  /** Enables ts-morph-based hook naming; omit to use index-based names (hook0, hook1, ...). */
  sourcePath?: string;
  /** Hook names whose string value is preserved verbatim instead of bucketed to empty/nonEmpty. */
  literalHooks?: string[];
  /** Hook names excluded from state identity entirely. */
  ignoreHooks?: string[];
  /** Full override; if it returns a StateKey, that value wins outright. */
  custom?: (snapshot: ComponentSnapshot) => StateKey | undefined;
}

/** Only these hook kinds contribute to state identity; everything else is presentation/plumbing. */
const IDENTITY_KINDS = new Set(["state", "reducer"]);

function indexBasedNames(identityHooks: HookRecord[]): string[] {
  return identityHooks.map((h) => `hook${h.index}`);
}

/**
 * Resolves the name for each identity-contributing hook. Tries the
 * ts-morph-derived source list first; falls back to index-based naming
 * (with a warning) whenever the source-derived list disagrees with the
 * runtime hook list in length or kind order, since a mismatch there means
 * the static analysis missed or misattributed a hook and trusting it would
 * silently produce a wrong mapping rather than a merely coarse one.
 */
function resolveHookNames(
  identityHooks: HookRecord[],
  options: AbstractionOptions,
  warnings: string[],
): string[] {
  const fallback = indexBasedNames(identityHooks);
  if (!options.sourcePath) return fallback;

  const naming = getHookNames(options.sourcePath, options.componentName);
  warnings.push(...naming.warnings);

  if (naming.names.length !== identityHooks.length) {
    warnings.push(
      `source-derived hook count (${naming.names.length}) disagrees with runtime state/reducer ` +
        `hook count (${identityHooks.length}) for ${options.componentName}; falling back to index-based naming`,
    );
    return fallback;
  }

  for (let i = 0; i < identityHooks.length; i++) {
    const sourceEntry = naming.names[i];
    const runtimeEntry = identityHooks[i];
    if (!sourceEntry || !runtimeEntry || sourceEntry.kind !== runtimeEntry.kind) {
      warnings.push(
        `source-derived hook kind order disagrees with runtime hook kind order at position ${i} ` +
          `for ${options.componentName} (source: ${sourceEntry?.kind}, runtime: ${runtimeEntry?.kind}); ` +
          `falling back to index-based naming`,
      );
      return fallback;
    }
  }

  return naming.names.map((n) => n.name);
}

/**
 * Abstracts one component's hook values into a StateKey. `custom`, if
 * provided and it returns a value, wins outright over the default rules.
 */
export function abstractState(snapshot: ComponentSnapshot, options: AbstractionOptions): StateKey {
  const custom = options.custom?.(snapshot);
  if (custom) return custom;

  const warnings: string[] = [];
  const identityHooks = snapshot.hooks.filter((h) => IDENTITY_KINDS.has(h.kind));
  const names = resolveHookNames(identityHooks, options, warnings);

  const ignore = new Set(options.ignoreHooks ?? []);
  const literal = new Set(options.literalHooks ?? []);

  const fields: Record<string, CanonToken> = {};
  identityHooks.forEach((hook, idx) => {
    const name = names[idx];
    if (!name || ignore.has(name)) return;
    fields[name] = canonicalise(hook.value, { literal: literal.has(name) });
  });

  const sortedKeys = Object.keys(fields).sort();
  const key = sortedKeys.map((k) => `${k}=${stableStringify(fields[k])}`).join("|");

  const result: StateKey & { warnings?: string[] } = { key, fields };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
