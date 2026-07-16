import { db } from "../lib/db.js";
import type { PriceResult } from "./rate-types.js";

export async function displayScheduledPrice(visitId: string): Promise<PriceResult> {
  const visit = await db.visit.findUniqueOrThrow({ include: { patient: true, visitGroup: { include: { visitSet: true } } }, where: { id: visitId } });
  const coverageId = visit.coverageId ?? visit.visitGroup.visitSet.coverageId ?? visit.patient.currentCoverageId;
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: coverageId! } });
  const rate = await db.payerRate.findFirstOrThrow({ where: {
    serviceType: visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
    locationId: visit.locationId,
    effectiveFrom: { lte: visit.scheduledStart },
    contract: { payerId: coverage.payerId, organizationId: visit.visitGroup.visitSet.organizationId },
  }, orderBy: { priority: "desc" } });
  return { amount: rate.amount, rateId: rate.id, source: "scheduled-location-rate" };
}

export async function authorizationPreviewPrice(visitSetId: string): Promise<PriceResult> {
  const set = await db.visitSet.findUniqueOrThrow({ include: { patient: true }, where: { id: visitSetId } });
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: set.coverageId ?? set.patient.currentCoverageId! } });
  const rate = await db.payerRate.findFirstOrThrow({ where: { serviceType: set.serviceType, contract: { payerId: coverage.payerId, organizationId: set.organizationId } }, orderBy: { amount: "asc" } });
  return { amount: rate.amount, rateId: rate.id, source: "authorization-cheapest-rate" };
}
