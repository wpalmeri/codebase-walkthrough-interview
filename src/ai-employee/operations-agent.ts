import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { moduleLogger } from "../lib/logger.js";
import { asJson } from "../lib/json.js";
import { runFakeModel } from "./fake-model.js";
import { buildOperationsContext, renderContextPrompt } from "./context-builder.js";
import { invokeTool, toolNames } from "./tools.js";
import { submitClaim } from "../revenue-cycle/claim-service.js";
import { createTask } from "../tasks/task-service.js";
import { aiServiceContext } from "../permissions/service-identity.js";

const log = moduleLogger("operations-agent");

/**
 * The AI employee's operational investigation loop.
 *
 * Flow: build context (over-broad, full PHI) -> render prompt -> log the
 * whole prompt to the general application log -> call the model -> run the
 * tool calls it asked for (trusted verbatim) -> persist a proposed action if
 * the model returned one. The UI presents proposed actions as reviewable,
 * but executeProposedAction below performs real, non-idempotent side effects
 * with no second human check beyond a status flip.
 */
export async function investigateBillingBlockers(organizationId: string, requestedBy: string) {
  const context = await buildOperationsContext(organizationId, "billing-blockers");
  const prompt = renderContextPrompt("Find visits that cannot be billed and explain why.", context);

  // Full prompt (including PHI) goes to the general log.
  log.info({ prompt }, "ai-employee prompt");

  const run = await db.aiRun.create({
    data: { organizationId, requestedBy, purpose: "billing-blockers", prompt, model: "fake-operations-1" },
  });

  const model = await runFakeModel({ prompt, availableTools: toolNames(), organizationId });
  log.info({ response: model.answer, proposedAction: model.proposedAction }, "ai-employee response");

  for (const call of model.toolCalls) {
    await invokeTool(call.tool, call.arguments, { organizationId, runId: run.id });
  }

  if (model.proposedAction) {
    await db.aiProposedAction.create({
      data: {
        runId: run.id,
        actionType: model.proposedAction.type,
        arguments: asJson(model.proposedAction.arguments) as Prisma.InputJsonValue,
        summary: model.proposedAction.summary,
      },
    });
  }

  return db.aiRun.update({
    where: { id: run.id },
    data: { status: "COMPLETED", response: model.answer, inputTokens: model.usage.inputTokens, outputTokens: model.usage.outputTokens, completedAt: new Date() },
    include: { proposedActions: true, toolInvocations: true },
  });
}

export async function askOperations(organizationId: string, requestedBy: string, question: string) {
  const focus = question.toLowerCase().includes("reject")
    ? "rejections"
    : question.toLowerCase().includes("revenue")
      ? "revenue"
      : question.toLowerCase().includes("document")
        ? "documentation"
        : "billing-blockers";
  const context = await buildOperationsContext(organizationId, focus);
  const prompt = renderContextPrompt(question, context);
  log.info({ prompt }, "ai-employee prompt");

  const run = await db.aiRun.create({ data: { organizationId, requestedBy, purpose: "ask", prompt, model: "fake-operations-1" } });
  const model = await runFakeModel({ prompt, availableTools: toolNames(), organizationId });

  const toolResults = [];
  for (const call of model.toolCalls) {
    toolResults.push({ tool: call.tool, result: await invokeTool(call.tool, call.arguments, { organizationId, runId: run.id }) });
  }
  if (model.proposedAction) {
    await db.aiProposedAction.create({
      data: { runId: run.id, actionType: model.proposedAction.type, arguments: asJson(model.proposedAction.arguments) as Prisma.InputJsonValue, summary: model.proposedAction.summary },
    });
  }

  const updated = await db.aiRun.update({
    where: { id: run.id },
    data: { status: "COMPLETED", response: model.answer, inputTokens: model.usage.inputTokens, outputTokens: model.usage.outputTokens, completedAt: new Date() },
    include: { proposedActions: true },
  });
  return { run: updated, answer: model.answer, provenance: context.provenance, toolResults };
}

/**
 * Executes a proposed action.
 *
 * "Approval" is just passing an approvedBy string; there is no verification
 * that the approver has permission to perform the underlying action, and the
 * action runs under a broad AI service identity. RESUBMIT_CLAIM hits the
 * clearinghouse (non-idempotent — a double execution double-submits), and
 * "from-context" placeholder arguments are resolved to the first matching
 * record at execution time rather than what a reviewer actually saw.
 */
export async function executeProposedAction(actionId: string, approvedBy = "user_admin") {
  const action = await db.aiProposedAction.findUniqueOrThrow({ where: { id: actionId }, include: { run: true } });
  const args = action.arguments as { claimId?: string; queue?: string; reason?: string };
  const context = aiServiceContext(action.run.organizationId);

  let result: unknown = { noop: true };
  if (action.actionType === "RESUBMIT_CLAIM") {
    let claimId = args.claimId;
    if (!claimId || claimId === "from-context") {
      const claim = await db.claim.findFirst({ where: { organizationId: action.run.organizationId, status: "REJECTED" }, orderBy: { createdAt: "asc" } });
      claimId = claim?.id;
    }
    if (claimId) result = await submitClaim(claimId);
  } else if (action.actionType === "ASSIGN_TASK") {
    result = await createTask(context, {
      title: "AI: documentation follow-up",
      description: `Assigned by AI employee (${args.reason ?? "operational"})`,
      priority: "HIGH",
    });
  }

  return db.aiProposedAction.update({
    where: { id: action.id },
    data: { status: "EXECUTED", approvedBy, executedAt: new Date(), executionResult: asJson(result) as Prisma.InputJsonValue },
  });
}

export async function listAiRuns(organizationId: string, limit = 25) {
  return db.aiRun.findMany({
    where: { organizationId },
    include: { proposedActions: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getAiRun(runId: string) {
  return db.aiRun.findUniqueOrThrow({ where: { id: runId }, include: { proposedActions: true, toolInvocations: true } });
}
