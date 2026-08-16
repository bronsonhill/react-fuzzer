import fc from "fast-check";

export default {
  exampleProps: { onSubmit: undefined },
  propOverrides: { onSubmit: fc.constant(() => {}) },
  fillPools: (field: { name: string }) => {
    if (/email/i.test(field.name)) return ["", "not-an-email@", "ada@example.com"];
    if (/password/i.test(field.name)) return ["", "short", "longenough1"];
    return undefined;
  },
};
