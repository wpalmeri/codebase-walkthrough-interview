import { db } from "../lib/db.js";

/**
 * There is no evaluation dataset for the AI employee. This module exists so
 * the UI can show a "quality" panel, but it only computes operational
 * proxies after the fact — proposed-vs-executed counts and tool error rates.
 * There are no golden questions, no labelled expected answers, and no
 * regression suite gating model or prompt changes.
 */

export interface AiQualitySnapshot {
  totalRuns: number;
  proposedActions: number;
  executedActions: number;
  toolInvocations: number;
  toolErrors: number;
  note: string;
}

export async function aiQualitySnapshot(organizationId: string): Promise<AiQualitySnapshot> {
  const totalRuns = await db.aiRun.count({ where: { organizationId } });
  const proposedActions = await db.aiProposedAction.count({ where: { run: { organizationId } } });
  const executedActions = await db.aiProposedAction.count({ where: { run: { organizationId }, status: "EXECUTED" } });
  const toolInvocations = await db.aiToolInvocation.count({ where: { run: { organizationId } } });
  const toolErrors = await db.aiToolInvocation.count({ where: { run: { organizationId }, error: { not: null } } });

  return {
    totalRuns,
    proposedActions,
    executedActions,
    toolInvocations,
    toolErrors,
    note: "No evaluation dataset exists. These are operational proxies only; model output is not scored against expected answers.",
  };
}
