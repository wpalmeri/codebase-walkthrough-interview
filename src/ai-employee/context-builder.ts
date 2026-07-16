import { db } from "../lib/db.js";

/**
 * Builds the context blob handed to the model.
 *
 * It loads far more than any single question needs — full patient rows,
 * demographics, coverage, and entire note bodies — and serializes them
 * straight into the prompt string. There is no PHI minimization and no
 * per-field allowlist; whatever is loaded is sent. Source provenance is a
 * flat list of ids with no stable references the answer can cite.
 */
export interface AiContext {
  organizationId: string;
  summary: {
    unsignedVisits: number;
    rejectedClaims: number;
    openBalance: number;
    unappliedCash: number;
  };
  records: unknown[];
  provenance: string[];
}

export async function buildOperationsContext(organizationId: string, focus: "billing-blockers" | "rejections" | "documentation" | "revenue"): Promise<AiContext> {
  const unsignedVisits = await db.visit.count({
    where: { status: "COMPLETED", visitGroup: { visitSet: { organizationId } }, notes: { none: { status: "SIGNED" } } },
  });
  const rejectedClaims = await db.claim.count({ where: { organizationId, status: "REJECTED" } });
  const openBalance = await db.claim.aggregate({ where: { organizationId, status: { notIn: ["PAID", "VOIDED"] } }, _sum: { balanceAmount: true } });
  const unappliedCash = await db.payment.aggregate({ where: { organizationId, unappliedAmount: { gt: 0 } }, _sum: { unappliedAmount: true } });

  // The "focus" only changes which records get loaded, but all of them carry
  // full PHI; nothing is redacted before it enters the prompt.
  let records: unknown[] = [];
  const provenance: string[] = [];
  if (focus === "billing-blockers" || focus === "documentation") {
    const visits = await db.visit.findMany({
      where: { status: "COMPLETED", visitGroup: { visitSet: { organizationId } }, notes: { none: { status: "SIGNED" } } },
      include: { patient: { include: { profile: true, demographics: true, coverages: true } }, notes: true, visitGroup: { include: { visitSet: { include: { authorization: true } }, branch: true } } },
      take: 50,
    });
    records = visits;
    provenance.push(...visits.map((visit) => `visit:${visit.id}`));
  } else if (focus === "rejections") {
    const claims = await db.claim.findMany({
      where: { organizationId, status: "REJECTED" },
      include: { patient: { include: { coverages: true } }, rejections: true, lines: { include: { chargeLine: true } } },
      take: 50,
    });
    records = claims;
    provenance.push(...claims.map((claim) => `claim:${claim.id}`));
  } else {
    const visits = await db.visit.findMany({
      where: { status: "COMPLETED", visitGroup: { visitSet: { organizationId } } },
      include: { patient: { include: { coverages: true } }, charges: true, visitGroup: { include: { visitSet: true } } },
      take: 50,
    });
    records = visits;
    provenance.push(...visits.map((visit) => `visit:${visit.id}`));
  }

  return {
    organizationId,
    summary: {
      unsignedVisits,
      rejectedClaims,
      openBalance: Number(openBalance._sum.balanceAmount ?? 0),
      unappliedCash: Number(unappliedCash._sum.unappliedAmount ?? 0),
    },
    records,
    provenance,
  };
}

export function renderContextPrompt(question: string, context: AiContext): string {
  // Full records are JSON-stringified into the prompt verbatim.
  return [
    `Question: ${question}`,
    `Organization: ${context.organizationId}`,
    `Summary: ${JSON.stringify(context.summary)}`,
    `Records: ${JSON.stringify(context.records)}`,
  ].join("\n");
}
