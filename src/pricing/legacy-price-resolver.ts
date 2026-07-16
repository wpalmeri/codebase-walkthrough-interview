import { db } from "../lib/db.js";
import { multiplyMoney } from "../lib/money.js";
import type { PriceResult } from "./rate-types.js";

export async function legacyVisitPrice(visitId: string): Promise<PriceResult> {
  const visit = await db.visit.findUniqueOrThrow({ include: { patient: true, visitGroup: { include: { visitSet: true } } }, where: { id: visitId } });
  const coverageId = visit.coverageId ?? visit.visitGroup.visitSet.coverageId ?? visit.patient.currentCoverageId;
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: coverageId! } });
  const rate = await db.payerRate.findFirst({ where: {
    serviceType: visit.visitGroup.visitSet.serviceType,
    contract: { payerId: coverage.payerId, organizationId: visit.visitGroup.visitSet.organizationId, active: true },
  } });
  if (!rate) return { amount: 100, rateId: "fallback", source: "standard-fallback" };
  const minutes = visit.actualStart && visit.actualEnd ? (visit.actualEnd.getTime() - visit.actualStart.getTime()) / 60_000 : 60;
  const units = rate.unit === "HOUR" ? Math.ceil(minutes / 15) / 4 : 1;
  return { amount: multiplyMoney(rate.amount.toString(), units).toNumber(), rateId: rate.id, source: "legacy-current-rate", units };
}
