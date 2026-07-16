import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { writeAudit } from "../audit/audit-service.js";

export interface NewCoverageInput {
  patientId: string;
  payerId: string;
  memberId: string;
  planName: string;
  groupNumber?: string;
  effectiveFrom: Date;
  priority?: number;
  copayAmount?: number;
  coinsurancePercent?: number;
}

/**
 * Adds a coverage and promotes it to the patient's current coverage.
 * Historical visits, charges, and estimates that resolved rates through the
 * previous currentCoverageId are not touched; anything that re-prices later
 * will use this new coverage.
 */
export async function addCoverage(context: RequestContext, input: NewCoverageInput) {
  const patient = await db.patient.findFirst({ where: { id: input.patientId, organizationId: context.organizationId } });
  if (!patient) throw new NotFoundError("Patient not found");

  const coverage = await db.insuranceCoverage.create({
    data: {
      patientId: input.patientId,
      payerId: input.payerId,
      memberId: input.memberId,
      planName: input.planName,
      groupNumber: input.groupNumber,
      effectiveFrom: input.effectiveFrom,
      priority: input.priority ?? 1,
      copayAmount: input.copayAmount,
      coinsurancePercent: input.coinsurancePercent,
    },
  });
  await db.patient.update({ where: { id: patient.id }, data: { currentCoverageId: coverage.id } });
  await writeAudit(context.organizationId, context.userId, "coverage.added", "InsuranceCoverage", coverage.id, {
    payerId: input.payerId,
    planName: input.planName,
  });
  return coverage;
}

/** Ends the current coverage and swaps the patient to a replacement in two separate writes. */
export async function replaceCoverage(context: RequestContext, patientId: string, endDate: Date, replacement: NewCoverageInput) {
  const patient = await db.patient.findFirstOrThrow({ where: { id: patientId, organizationId: context.organizationId } });
  if (patient.currentCoverageId) {
    await db.insuranceCoverage.update({ where: { id: patient.currentCoverageId }, data: { effectiveTo: endDate } });
  }
  return addCoverage(context, replacement);
}

export async function coverageHistory(context: RequestContext, patientId: string) {
  const patient = await db.patient.findFirstOrThrow({ where: { id: patientId, organizationId: context.organizationId } });
  const coverages = await db.insuranceCoverage.findMany({
    where: { patientId },
    include: { payer: true, eligibilityChecks: { orderBy: { checkedAt: "desc" }, take: 1 } },
    orderBy: { effectiveFrom: "desc" },
  });
  return coverages.map((coverage) => ({
    id: coverage.id,
    payerName: coverage.payer.name,
    payerCode: coverage.payer.code,
    planName: coverage.planName,
    memberId: coverage.memberId,
    priority: coverage.priority,
    effectiveFrom: coverage.effectiveFrom,
    effectiveTo: coverage.effectiveTo,
    isCurrent: coverage.id === patient.currentCoverageId,
    lastEligibility: coverage.eligibilityChecks[0] ?? null,
  }));
}
