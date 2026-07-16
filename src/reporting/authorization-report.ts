import { db } from "../lib/db.js";

/**
 * Authorization utilization board.
 *
 * Iterates active visit sets and runs two counts per set. The report shows
 * both usage columns the business uses: authorizedVisitsUsed counts Visit
 * rows in SCHEDULED/IN_PROGRESS/COMPLETED with no date bounds, while
 * deliveredUnits counts completed VisitGroups (the billing view's unit).
 * Multi-visit groups make the two columns disagree for the same set.
 */
export async function authorizationUtilization(organizationId: string) {
  // Active sets only; a discharged set drops off the board even when its
  // authorization is still open.
  const sets = await db.visitSet.findMany({
    where: { organizationId, status: "ACTIVE", deletedAt: null, authorizationId: { not: null } },
    include: {
      authorization: true,
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { startDate: "asc" },
  });

  const rows = [];
  for (const set of sets) {
    const authorization = set.authorization;
    if (!authorization) continue;
    const authorizedVisitsUsed = await db.visit.count({
      where: { visitGroup: { visitSetId: set.id }, status: { in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"] }, deletedAt: null },
    });
    const deliveredUnits = await db.visitGroup.count({
      where: { visitSetId: set.id, status: "COMPLETED", deletedAt: null },
    });
    // visit-service's authorizationUsage applies the Evergreen
    // cancelled-visits override (customer-overrides.ts); this report does
    // not, so the visit-detail panel and this board can disagree for them.
    const remaining = authorization.maxVisits - authorizedVisitsUsed;
    const percentUsed = authorization.maxVisits > 0 ? Math.round((authorizedVisitsUsed / authorization.maxVisits) * 100) : 0;
    rows.push({
      authorizationId: authorization.id,
      authNumber: authorization.authorizationNumber,
      patientId: set.patientId,
      patientName: `${set.patient.firstName} ${set.patient.lastName}`,
      serviceType: set.serviceType,
      effectiveTo: authorization.effectiveTo,
      maxVisits: authorization.maxVisits,
      authorizedVisitsUsed,
      deliveredUnits,
      remaining,
      percentUsed,
      nearLimit: percentUsed >= 80,
    });
  }
  return rows;
}
