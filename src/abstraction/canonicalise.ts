/**
 * Maps a runtime hook value to a deterministic, JSON-serialisable abstract
 * token, per the plan's bucketing rules:
 *
 *   - booleans kept verbatim
 *   - strings reduced to "empty" / "nonEmpty" (or preserved verbatim when
 *     `literal: true`, for string-literal-union-shaped state — see
 *     AbstractionOptions.literalHooks in ./index.ts)
 *   - numbers to a sign-and-zero bucket: "zero" / "positive" / "negative"
 *   - arrays, Sets, Maps to a size bucket: "empty" / "one" / "many"
 *   - null and undefined kept as distinct tokens
 *   - plain objects recursed into one level (key-sorted), then a type tag
 *   - functions and anything unrecognised to a type tag
 *
 * The same input always produces the same output, and every branch returns
 * either a primitive or a plain object with sorted keys, so `stableStringify`
 * below can turn any token into a canonical string regardless of key
 * insertion order.
 */

export type CanonToken =
  | boolean
  | string
  | { [key: string]: CanonToken };

export interface CanonicaliseOptions {
  /** Preserve the string verbatim instead of bucketing to empty/nonEmpty. */
  literal?: boolean;
  /** Remaining levels of object recursion; defaults to 1 (one level deep). */
  depth?: number;
}

function sizeBucket(size: number): "empty" | "one" | "many" {
  if (size === 0) return "empty";
  if (size === 1) return "one";
  return "many";
}

export function canonicalise(value: unknown, options: CanonicaliseOptions = {}): CanonToken {
  const depth = options.depth ?? 1;

  if (value === null) return "null:null";
  if (value === undefined) return "undefined:undefined";

  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    if (options.literal) return `lit:${value}`;
    return value.length === 0 ? "empty" : "nonEmpty";
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "positive" : "negative";
    if (value === 0) return "zero";
    return value > 0 ? "positive" : "negative";
  }

  if (typeof value === "function") return "type:function";
  if (typeof value === "symbol") return "type:symbol";
  if (typeof value === "bigint") return value === 0n ? "zero" : value > 0n ? "positive" : "negative";

  if (Array.isArray(value)) return `arr:${sizeBucket(value.length)}`;
  if (value instanceof Set) return `set:${sizeBucket(value.size)}`;
  if (value instanceof Map) return `map:${sizeBucket(value.size)}`;
  if (value instanceof Date) return "type:date";

  if (typeof value === "object") {
    if (depth <= 0) return "type:object";
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const fields: { [key: string]: CanonToken } = {};
    for (const key of keys) {
      fields[key] = canonicalise(obj[key], { depth: depth - 1 });
    }
    return fields;
  }

  return `type:${typeof value}`;
}

/**
 * Canonical, key-order-independent string form of a token (or any
 * JSON-serialisable value), used to build a state key from a set of tokens.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
