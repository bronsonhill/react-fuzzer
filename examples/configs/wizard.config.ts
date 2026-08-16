import fc from "fast-check";

export default {
  exampleProps: { onComplete: undefined },
  propOverrides: { onComplete: fc.constant(() => {}) },
  fillPools: (field: { name: string }) => {
    if (/name/i.test(field.name)) return ["", "Ada"];
    if (/email/i.test(field.name)) return ["", "ada@example.com"];
    return undefined;
  },
};
