import type { WorkflowExecution } from "@prisma/client";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";
import { moduleLogger } from "../lib/logger.js";
import { evaluateCondition } from "./expression.js";
import { performAction, type WorkflowAction } from "./workflow-actions.js";

const log = moduleLogger("workflow-runner");
const MAX_CHAIN_DEPTH = 5;

/**
 * Processes a single DomainEvent against matching, enabled workflows.
 *
 * Behavior worth reviewing:
 *  - Matching is exact-string on eventName; the event catalog has three
 *    naming styles, so a workflow authored for "claim.rejected" never fires
 *    for the "claim_rejected" some emitters use.
 *  - Definitions are mutable; a workflow edited mid-flight is read fresh for
 *    each event, so in-flight executions can use a newer action list than the
 *    one that matched.
 *  - Actions run sequentially; one failing action fails the whole execution
 *    and later actions never run (no per-action retry, no compensation).
 *  - Retry is by re-running processPendingEvents, which reprocesses the event
 *    against ALL workflows again — already-succeeded workflows re-fire.
 */
export async function processEvent(eventId: string, depth = 0): Promise<WorkflowExecution[]> {
  const event = await db.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
  const payload = { ...(event.payload as Record<string, unknown>), organizationId: event.organizationId };

  const workflows = await db.workflowDefinition.findMany({
    where: { organizationId: event.organizationId, eventName: event.eventName, enabled: true },
  });

  const results: WorkflowExecution[] = [];
  for (const workflow of workflows) {
    if (!evaluateCondition(workflow.condition, payload)) continue;

    const execution = await db.workflowExecution.create({
      data: { workflowId: workflow.id, eventId, status: "RUNNING", input: asJson(payload), dedupeKey: `${workflow.id}:${eventId}` },
    });
    try {
      const outputs: unknown[] = [];
      for (const action of workflow.actions as unknown as WorkflowAction[]) {
        outputs.push(await performAction(action, payload));
        if (action.type === "emit" && depth < MAX_CHAIN_DEPTH) {
          // Chained emits are processed after this action returns; the depth
          // guard is the only loop protection.
          const chained = await db.domainEvent.findFirst({ where: { processedAt: null, aggregateType: "Workflow" }, orderBy: { occurredAt: "desc" } });
          if (chained) await processEvent(chained.id, depth + 1);
        }
      }
      results.push(
        await db.workflowExecution.update({
          where: { id: execution.id },
          data: { status: "COMPLETED", output: asJson(outputs), completedAt: new Date() },
        }),
      );
    } catch (error) {
      log.warn({ workflowId: workflow.id, eventId, error: error instanceof Error ? error.message : String(error) }, "workflow execution failed");
      results.push(
        await db.workflowExecution.update({
          where: { id: execution.id },
          data: { status: "FAILED", error: error instanceof Error ? error.message : String(error), completedAt: new Date() },
        }),
      );
    }
  }

  await db.domainEvent.update({ where: { id: eventId }, data: { processedAt: new Date(), attempts: { increment: 1 } } });
  return results;
}

export async function processPendingEvents(limit = 25) {
  const events = await db.domainEvent.findMany({ where: { processedAt: null }, take: limit, orderBy: { occurredAt: "asc" } });
  const results = [];
  for (const event of events) results.push(await processEvent(event.id));
  return results;
}
