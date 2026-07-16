import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";
import { requirePolicy } from "../permissions/policy-service.js";
import type { Condition } from "./expression.js";
import type { WorkflowAction } from "./workflow-actions.js";

export interface WorkflowInput {
  name: string;
  description?: string;
  eventName: string;
  condition: Condition;
  actions: WorkflowAction[];
  enabled?: boolean;
}

/**
 * Creates or edits a workflow definition.
 *
 * Edits mutate the existing row and bump `version`, but running executions
 * and the audit trail keep no copy of the prior definition — "what did this
 * automation do last month" can't be answered after an edit.
 */
export async function saveWorkflow(context: RequestContext, input: WorkflowInput, workflowId?: string) {
  requirePolicy(context, "workflow.manage");
  if (workflowId) {
    const existing = await db.workflowDefinition.findFirst({ where: { id: workflowId, organizationId: context.organizationId } });
    if (!existing) throw new NotFoundError("Workflow not found");
    return db.workflowDefinition.update({
      where: { id: workflowId },
      data: {
        name: input.name,
        description: input.description,
        eventName: input.eventName,
        condition: asJson(input.condition),
        actions: asJson(input.actions),
        enabled: input.enabled ?? existing.enabled,
        version: existing.version + 1,
        updatedBy: context.userId,
        updatedAt: new Date(),
      },
    });
  }
  return db.workflowDefinition.create({
    data: {
      organizationId: context.organizationId,
      name: input.name,
      description: input.description,
      eventName: input.eventName,
      condition: asJson(input.condition),
      actions: asJson(input.actions),
      enabled: input.enabled ?? false,
      createdBy: context.userId,
      updatedBy: context.userId,
    },
  });
}

export async function listWorkflows(context: RequestContext) {
  const workflows = await db.workflowDefinition.findMany({
    where: { organizationId: context.organizationId },
    include: { executions: { orderBy: { startedAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
  });
  const rows = [];
  for (const workflow of workflows) {
    const executionCount = await db.workflowExecution.count({ where: { workflowId: workflow.id } });
    const failureCount = await db.workflowExecution.count({ where: { workflowId: workflow.id, status: "FAILED" } });
    rows.push({
      id: workflow.id,
      name: workflow.name,
      eventName: workflow.eventName,
      enabled: workflow.enabled,
      version: workflow.version,
      actionCount: Array.isArray(workflow.actions) ? workflow.actions.length : 0,
      executionCount,
      failureCount,
      lastExecution: workflow.executions[0] ?? null,
    });
  }
  return rows;
}

export async function toggleWorkflow(context: RequestContext, workflowId: string, enabled: boolean) {
  requirePolicy(context, "workflow.manage");
  const workflow = await db.workflowDefinition.findFirst({ where: { id: workflowId, organizationId: context.organizationId } });
  if (!workflow) throw new NotFoundError("Workflow not found");
  return db.workflowDefinition.update({ where: { id: workflowId }, data: { enabled } });
}

export async function workflowExecutions(context: RequestContext, workflowId: string, limit = 50) {
  const workflow = await db.workflowDefinition.findFirst({ where: { id: workflowId, organizationId: context.organizationId } });
  if (!workflow) throw new NotFoundError("Workflow not found");
  return db.workflowExecution.findMany({ where: { workflowId }, orderBy: { startedAt: "desc" }, take: limit });
}

export async function recentExecutions(context: RequestContext, limit = 50) {
  return db.workflowExecution.findMany({
    where: { workflow: { organizationId: context.organizationId } },
    include: { workflow: { select: { name: true, eventName: true } } },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
