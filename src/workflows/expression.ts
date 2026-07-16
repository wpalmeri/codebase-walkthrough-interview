/**
 * Condition evaluator for workflow definitions.
 *
 * Two shapes are supported: the simple {field, op, value} rule and a nested
 * {and: [...]} / {or: [...]} tree. The "expr" operator evaluates a raw string
 * expression against the payload using the Function constructor — it was
 * added for one customer who needed "amount > 500 && branch == 'sf'" and now
 * runs whatever any definition contains. Definitions are customer-editable.
 */

export type Condition =
  | { field: string; op: string; value?: unknown }
  | { and: Condition[] }
  | { or: Condition[] }
  | { expr: string }
  | Record<string, never>;

function evaluateLeaf(rule: { field?: string; op?: string; value?: unknown }, payload: Record<string, unknown>): boolean {
  if (!rule.field) return true;
  const actual = payload[rule.field];
  switch (rule.op) {
    case "equals":
      return actual === rule.value;
    case "not_equals":
      return actual !== rule.value;
    case "contains":
      return String(actual ?? "").includes(String(rule.value));
    case "greater_than":
      return Number(actual) > Number(rule.value);
    case "less_than":
      return Number(actual) < Number(rule.value);
    case "gte":
      return Number(actual) >= Number(rule.value);
    case "lte":
      return Number(actual) <= Number(rule.value);
    case "in":
      return Array.isArray(rule.value) && rule.value.includes(actual);
    case "exists":
      return actual !== undefined && actual !== null;
    default:
      return true;
  }
}

export function evaluateCondition(condition: unknown, payload: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== "object") return true;
  const node = condition as Record<string, unknown>;

  if (Array.isArray(node.and)) return (node.and as Condition[]).every((child) => evaluateCondition(child, payload));
  if (Array.isArray(node.or)) return (node.or as Condition[]).some((child) => evaluateCondition(child, payload));

  if (typeof node.expr === "string") {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("payload", `with (payload) { return (${node.expr}); }`);
      return Boolean(fn(payload));
    } catch {
      return false;
    }
  }

  return evaluateLeaf(node as { field?: string; op?: string; value?: unknown }, payload);
}
