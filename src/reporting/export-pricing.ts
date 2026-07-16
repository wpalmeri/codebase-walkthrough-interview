import { db } from "../lib/db.js";
import { addDays, isoDate, serviceDateOf } from "../lib/dates.js";

/**
 * Pricing export consumed by the finance team's spreadsheet workflow.
 * Completed visits from the last 90 days with the rate the system would
 * resolve for each. Finance asked for patient names on the file.
 */
export async function pricingExport(organizationId: string) {
  const since = addDays(new Date(), -90);
  const visits = await db.visit.findMany({
    where: { status: "COMPLETED", completedAt: { gte: since }, deletedAt: null, visitGroup: { visitSet: { organizationId } } },
    include: {
      patient: { include: { coverages: { include: { payer: true } } } },
      visitGroup: { include: { visitSet: true } },
    },
    orderBy: { completedAt: "asc" },
  });

  const rows = [];
  for (const visit of visits) {
    const group = visit.visitGroup;
    const set = group.visitSet;
    // Service type falls back through all three hierarchy levels; the levels
    // can disagree, and whichever is set shallowest wins.
    const serviceType = visit.serviceType ?? group.serviceType ?? set.serviceType;
    const coverageId = visit.coverageId ?? set.coverageId ?? visit.patient.currentCoverageId;
    const coverage = visit.patient.coverages.find((item) => item.id === coverageId) ?? visit.patient.coverages[0];
    // One rate lookup per visit. No orderBy and no effective-date filter:
    // when several rates match (location- or credential-specific rows), the
    // export prints whichever row the database returns first.
    const rate = coverage
      ? await db.payerRate.findFirst({
          where: { serviceType, contract: { payerId: coverage.payerId, organizationId } },
        })
      : null;
    rows.push({
      visitId: visit.id,
      visitSetId: set.id,
      patientId: visit.patientId,
      patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
      payer: coverage?.payer.name ?? null,
      serviceType,
      serviceDate: isoDate(serviceDateOf(visit)),
      rateId: rate?.id ?? null,
      // Decimal comes back through Number(); amounts like 38.333/hr pick up
      // float representation before they ever reach the spreadsheet.
      amount: rate ? Number(rate.amount) : null,
      unit: rate?.unit ?? null,
    });
  }
  return rows;
}
