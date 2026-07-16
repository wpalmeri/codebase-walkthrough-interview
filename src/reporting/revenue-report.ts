import { db } from "../lib/db.js";

interface RevenueRow {
  serviceType: string;
  branchId: string;
  branchName: string;
  visitCount: number;
  chargedRevenue: number;
  estimatedRevenue: number;
  revenue: number;
}

/**
 * Revenue by service type and branch.
 *
 * A visit is "completed" here when completedAt falls inside the window.
 * Pricing prefers the posted Charge; visits without one are priced at the
 * contract rate effective *today*, not at the service date. The operations
 * dashboard sums claim totals created in the window instead, and month-close
 * re-derives accruals — three revenue numbers that will not reconcile.
 *
 * Takes a bare organizationId: no role gate and no branch scoping here (the
 * catalog runner gates the catalog path; the /reports/revenue route does not).
 */
export async function revenueReport(organizationId: string, start: Date, end: Date) {
  const visits = await db.visit.findMany({
    where: { status: "COMPLETED", completedAt: { gte: start, lt: end }, deletedAt: null, visitGroup: { visitSet: { organizationId } } },
    include: {
      charges: true,
      patient: { include: { coverages: true } },
      visitGroup: { include: { branch: true, visitSet: true } },
    },
  });

  const now = new Date();
  const buckets = new Map<string, RevenueRow>();
  let fromCharges = 0;
  let fromRateFallback = 0;
  let unpricedVisits = 0;

  for (const visit of visits) {
    const set = visit.visitGroup.visitSet;
    const posted = visit.charges.find((charge) => charge.postedAt !== null && charge.totalAmount !== null);
    let amount = 0;
    if (posted && posted.totalAmount !== null) {
      amount = Number(posted.totalAmount);
      fromCharges += 1;
    } else {
      // One rate lookup per unpriced visit.
      const coverageId = visit.coverageId ?? set.coverageId ?? visit.patient.currentCoverageId;
      const coverage = visit.patient.coverages.find((item) => item.id === coverageId) ?? visit.patient.coverages[0];
      const rate = coverage
        ? await db.payerRate.findFirst({
            where: {
              serviceType: set.serviceType,
              contract: { payerId: coverage.payerId, organizationId, active: true },
              effectiveFrom: { lte: now },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
            orderBy: { priority: "desc" },
          })
        : null;
      if (rate) {
        amount = Number(rate.amount);
        fromRateFallback += 1;
      } else {
        unpricedVisits += 1;
      }
    }

    // Grouped by the set-level service type; visit-level overrides are ignored.
    const key = `${set.serviceType}|${visit.visitGroup.branchId}`;
    const row = buckets.get(key) ?? {
      serviceType: set.serviceType,
      branchId: visit.visitGroup.branchId,
      branchName: visit.visitGroup.branch.name,
      visitCount: 0,
      chargedRevenue: 0,
      estimatedRevenue: 0,
      revenue: 0,
    };
    row.visitCount += 1;
    if (posted && posted.totalAmount !== null) row.chargedRevenue += amount;
    else row.estimatedRevenue += amount;
    row.revenue += amount;
    buckets.set(key, row);
  }

  const rows = [...buckets.values()].sort((a, b) => b.revenue - a.revenue);
  return {
    rows,
    totals: {
      visitCount: visits.length,
      revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
      fromCharges,
      fromRateFallback,
      unpricedVisits,
    },
    methodology: "charges-then-current-rates",
  };
}
