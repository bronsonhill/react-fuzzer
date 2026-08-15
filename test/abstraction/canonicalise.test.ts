import { describe, expect, it } from "vitest";
import { canonicalise, stableStringify } from "../../src/abstraction/canonicalise.js";

describe("canonicalise", () => {
  it("keeps booleans verbatim", () => {
    expect(canonicalise(true)).toBe(true);
    expect(canonicalise(false)).toBe(false);
  });

  it("buckets strings to empty/nonEmpty by default", () => {
    expect(canonicalise("")).toBe("empty");
    expect(canonicalise("a")).toBe("nonEmpty");
    expect(canonicalise("a whole sentence")).toBe("nonEmpty");
  });

  it("preserves the literal string when literal: true", () => {
    expect(canonicalise("loading", { literal: true })).toBe("lit:loading");
    expect(canonicalise("error", { literal: true })).toBe("lit:error");
    expect(canonicalise("loading", { literal: true })).not.toBe(canonicalise("error", { literal: true }));
  });

  it("buckets numbers to zero/positive/negative", () => {
    expect(canonicalise(0)).toBe("zero");
    expect(canonicalise(5)).toBe("positive");
    expect(canonicalise(-5)).toBe("negative");
    expect(canonicalise(0.5)).toBe("positive");
    expect(canonicalise(-0.5)).toBe("negative");
  });

  it("does not distinguish magnitudes within a sign bucket", () => {
    expect(canonicalise(1)).toBe(canonicalise(1000));
    expect(canonicalise(-1)).toBe(canonicalise(-1000));
  });

  it("buckets arrays/Sets/Maps to empty/one/many", () => {
    expect(canonicalise([])).toBe("arr:empty");
    expect(canonicalise([1])).toBe("arr:one");
    expect(canonicalise([1, 2])).toBe("arr:many");
    expect(canonicalise([1, 2, 3, 4, 5])).toBe("arr:many");

    expect(canonicalise(new Set())).toBe("set:empty");
    expect(canonicalise(new Set([1]))).toBe("set:one");
    expect(canonicalise(new Set([1, 2]))).toBe("set:many");

    expect(canonicalise(new Map())).toBe("map:empty");
    expect(canonicalise(new Map([["a", 1]]))).toBe("map:one");
    expect(canonicalise(new Map([["a", 1], ["b", 2]]))).toBe("map:many");
  });

  it("keeps null and undefined as distinct tokens", () => {
    expect(canonicalise(null)).not.toBe(canonicalise(undefined));
    expect(canonicalise(null)).toBe("null:null");
    expect(canonicalise(undefined)).toBe("undefined:undefined");
  });

  it("recurses into plain objects one level, key-sorted", () => {
    const token = canonicalise({ b: "x", a: 1 });
    expect(token).toEqual({ a: "positive", b: "nonEmpty" });
  });

  it("stops recursing beyond depth 1 and emits a type tag", () => {
    const token = canonicalise({ a: { b: { c: 1 } } });
    expect(token).toEqual({ a: "type:object" });
  });

  it("is deterministic under key-order permutation of the input object", () => {
    const t1 = canonicalise({ a: 1, b: "x", c: true });
    const t2 = canonicalise({ c: true, a: 1, b: "x" });
    expect(stableStringify(t1)).toBe(stableStringify(t2));
  });

  it("maps functions and unrecognised values to a type tag", () => {
    expect(canonicalise(() => {})).toBe("type:function");
    expect(canonicalise(Symbol("x"))).toBe("type:symbol");
  });

  it("produces JSON-serialisable output", () => {
    const token = canonicalise({ name: "x", count: 3, flag: true, list: [1, 2] });
    expect(() => JSON.stringify(token)).not.toThrow();
  });
});

describe("stableStringify", () => {
  it("is order-independent for object keys", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("distinguishes different values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("handles nested arrays and objects", () => {
    expect(stableStringify({ a: [1, { b: 2, c: 3 }] })).toBe(
      stableStringify({ a: [1, { c: 3, b: 2 }] }),
    );
  });
});
