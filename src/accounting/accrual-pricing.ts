import { db } from "../lib/db.js";

export async function unbilledAccrual(organizationId: string, asOf: Date) {
  const visits = await db.visit.findMany({ where: { status: "COMPLETED", completedAt: { lte: asOf }, charges: { none: {} }, visitGroup: { visitSet: { organizationId } } }, include: { patient: true, visitGroup: { include: { visitSet: true } } } });
  let total = 0;
  for (const visit of visits) {
    const coverage = await db.insuranceCoverage.findUnique({ where: { id: visit.visitGroup.visitSet.coverageId ?? visit.patient.currentCoverageId! } });
    const rate = coverage ? await db.payerRate.findFirst({ where: { serviceType: visit.visitGroup.visitSet.serviceType, contract: { payerId: coverage.payerId, organizationId } } }) : null;
    total += Number(rate?.amount ?? 100);
  }
  return { organizationId, asOf, count: visits.length, total };
}
