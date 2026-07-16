import { vi } from "vitest";
import { db } from "../../src/lib/db.js";
import { askOperations, executeProposedAction } from "../../src/ai-employee/operations-agent.js";
import { buildOperationsContext } from "../../src/ai-employee/context-builder.js";
import { aiQualitySnapshot } from "../../src/ai-employee/evaluation.js";

async function cleanupRun(runId: string): Promise<void> {
  await db.aiToolInvocation.deleteMany({ where: { runId } });
  await db.aiProposedAction.deleteMany({ where: { runId } });
  await db.aiRun.delete({ where: { id: runId } });
}

describe("AI employee prototype", () => {
  it("answers a rejection question and proposes a resubmit action", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await askOperations("org_northstar", "user_admin", "Which claims were rejected and why?");
    expect(result.answer).toMatch(/reject/i);
    expect(result.run.proposedActions.some((action) => action.actionType === "RESUBMIT_CLAIM")).toBe(true);
    await cleanupRun(result.run.id);
    log.mockRestore();
  });

  it("loads full patient PHI into the model context without minimization", async () => {
    const context = await buildOperationsContext("org_northstar", "billing-blockers");
    const record = context.records[0] as { patient?: { dateOfBirth?: unknown; demographics?: unknown } } | undefined;
    // The context carries whole patient rows including DOB and demographics.
    expect(record?.patient?.dateOfBirth).toBeDefined();
    expect(context.provenance.length).toBeGreaterThan(0);
  });

  it("executes a proposed action under a broad service identity with only a status flip", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await askOperations("org_northstar", "user_admin", "What documentation is missing?");
    const action = result.run.proposedActions.find((candidate) => candidate.actionType === "ASSIGN_TASK");
    expect(action).toBeDefined();
    const executed = await executeProposedAction(action!.id, "user_admin");
    expect(executed.status).toBe("EXECUTED");

    // The execution created a task; clean it up along with the run.
    await db.taskRecord.deleteMany({ where: { organizationId: "org_northstar", title: { contains: "AI:" }, source: "MANUAL" } });
    await cleanupRun(result.run.id);
    log.mockRestore();
  });

  it("reports AI quality as operational proxies with no evaluation dataset", async () => {
    const snapshot = await aiQualitySnapshot("org_northstar");
    expect(snapshot.note).toMatch(/no evaluation dataset/i);
    expect(snapshot.totalRuns).toBeGreaterThanOrEqual(0);
  });
});
