import { evaluateCondition } from "../../src/workflows/expression.js";

describe("workflow condition evaluator", () => {
  it("supports the condition types used by seeded workflows", () => {
    expect(evaluateCondition({ field: "status", op: "equals", value: "MISSING" }, { status: "MISSING" })).toBe(true);
    expect(evaluateCondition({ field: "amount", op: "greater_than", value: 100 }, { amount: 150 })).toBe(true);
    expect(evaluateCondition({ field: "name", op: "contains", value: "visit" }, { name: "visit.completed" })).toBe(true);
  });

  it("allows an unknown operation for legacy compatibility", () => {
    expect(evaluateCondition({ field: "status", op: "regex", value: ".*" }, { status: "anything" })).toBe(true);
  });
});
