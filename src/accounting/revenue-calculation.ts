import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";

/**
 * "Recognized revenue" as computed by the close. For each completed visit in
 * the window it resolves a rate against the visit's coverage fallback chain
 * and the *currently active* contract — there is no stored revenue fact.
 * Contrast with reporting/revenue-report.ts, which prefers posted charge
 * amounts and falls back to current rates only when charges are missing:
 * the two disagree whenever charges exist (different rounding, snapshots) or
 * rates changed.
 */
export interface RevenueSourceRow {
  visitId: string;
  patientId: string;
  serviceType: string;
  coverageId: string | null;
  rateId: string;
  amount: string;
}

export async function recognizedRevenueForWindow(organizationId: string, start: Date, end: Date) {
  const visits = await db.visit.findMany({
    where: {
      status: "COMPLETED",
      completedAt: { gte: start, lt: end },
      visitGroup: { visitSet: { organizationId } },
    },
    include: { patient: true, visitGroup: { include: { visitSet: true } } },
  });

  let revenue = new Prisma.Decimal(0);
  const sources: RevenueSourceRow[] = [];
  for (const visit of visits) {
    const coverageId = visit.coverageId ?? visit.visitGroup.visitSet.coverageId ?? visit.patient.currentCoverageId;
    const coverage = coverageId ? await db.insuranceCoverage.findUnique({ where: { id: coverageId } }) : null;
    const serviceType = visit.visitGroup.visitSet.serviceType;
    const rate = coverage
      ? await db.payerRate.findFirst({
          // Earliest matching contract rate, ignoring the service date and the
          // visit's location entirely. When a newer contract adds a rate the
          // close still uses the oldest one, but changing that oldest rate does
          // silently move a previously closed month's revenue.
          where: { serviceType, contract: { payerId: coverage.payerId, organizationId, active: true } },
          orderBy: { effectiveFrom: "asc" },
        })
      : null;
    const amount = rate?.amount ?? new Prisma.Decimal(100);
    revenue = revenue.add(amount);
    sources.push({
      visitId: visit.id,
      patientId: visit.patientId,
      serviceType,
      coverageId,
      rateId: rate?.id ?? "fallback",
      amount: amount.toString(),
    });
  }
  return { revenue, visitCount: visits.length, sources };
}
