import { db } from "../lib/db.js";

export async function completionValue(visitId: string) {
  const visit = await db.visit.findUniqueOrThrow({ include: { visitGroup: { include: { visitSet: true } }, patient: true }, where: { id: visitId } });
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: visit.coverageId ?? visit.patient.currentCoverageId! } });
  const serviceType = visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType;
  const rate = await db.payerRate.findFirstOrThrow({ where: { serviceType, effectiveFrom: { lte: visit.completedAt ?? new Date() }, contract: { payerId: coverage.payerId, organizationId: visit.visitGroup.visitSet.organizationId } }, orderBy: { priority: "desc" } });
  return { amount: Math.round(Number(rate.amount) * 100) / 100, rateId: rate.id, serviceType };
}
