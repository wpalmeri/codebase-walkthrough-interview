import { db } from "../../src/lib/db.js";
import { evaluateCondition } from "../../src/workflows/expression.js";
import { processEvent } from "../../src/workflows/workflow-runner.js";
import { ACTION_CATALOG } from "../../src/workflows/action-catalog.js";

describe("workflow engine", () => {
  it("evaluates the permissive raw-expression condition against the payload", () => {
    // The expr operator runs an arbitrary string against the payload.
    expect(evaluateCondition({ expr: "amount > 500 && branch === 'sf'" }, { amount: 900, branch: "sf" })).toBe(true);
    expect(evaluateCondition({ expr: "amount > 500" }, { amount: 100 })).toBe(false);
  });

  it("supports nested and/or condition trees", () => {
    const condition = { and: [{ field: "status", op: "equals", value: "READY" }, { or: [{ field: "amount", op: "gte", value: 100 }, { field: "urgent", op: "exists" }] }] };
    expect(evaluateCondition(condition, { status: "READY", amount: 150 })).toBe(true);
    expect(evaluateCondition(condition, { status: "READY", amount: 10 })).toBe(false);
  });

  it("only matches workflows whose event name string is exactly equal", async () => {
    // Seeded enterprise workflow listens for "claim.rejected"; an emitter using
    // "claim_rejected" would never trigger it.
    const dotEvent = await db.domainEvent.create({ data: { organizationId: "org_evergreen", eventName: "claim.rejected", aggregateType: "Claim", aggregateId: "x", payload: { claimId: "x" } } });
    const snakeEvent = await db.domainEvent.create({ data: { organizationId: "org_evergreen", eventName: "claim_rejected", aggregateType: "Claim", aggregateId: "y", payload: { claimId: "y" } } });

    const matched = await processEvent(dotEvent.id);
    const unmatched = await processEvent(snakeEvent.id);
    expect(matched.length).toBeGreaterThan(0);
    expect(unmatched.length).toBe(0);

    await db.workflowExecution.deleteMany({ where: { eventId: { in: [dotEvent.id, snakeEvent.id] } } });
    await db.taskRecord.deleteMany({ where: { organizationId: "org_evergreen", source: "WORKFLOW", title: "Rework rejected claim" } });
    await db.domainEvent.deleteMany({ where: { id: { in: [dotEvent.id, snakeEvent.id] } } });
  });

  it("exposes an action catalog the runner does not actually enforce", () => {
    expect(ACTION_CATALOG.some((action) => action.type === "webhook" && action.sideEffect === "external")).toBe(true);
  });
});
