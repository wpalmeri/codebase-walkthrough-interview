import { db } from "../lib/db.js";

export async function claimLinePrice(chargeLineId: string) {
  const line = await db.chargeLine.findUniqueOrThrow({ include: { charge: { include: { visit: { include: { patient: true, visitGroup: { include: { visitSet: true } } } } } } }, where: { id: chargeLineId } });
  const visit = line.charge.visit;
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: line.charge.coverageId ?? visit.patient.currentCoverageId! } });
  const rate = await db.payerRate.findFirstOrThrow({ where: { serviceType: line.serviceCode, contract: { payerId: coverage.payerId, organizationId: visit.visitGroup.visitSet.organizationId } }, orderBy: [{ priority: "desc" }, { effectiveFrom: "desc" }] });
  return { chargeLineId, units: Number(line.units), unitPrice: Number(rate.amount), amount: Number(line.units) * Number(rate.amount), rateId: rate.id };
}
