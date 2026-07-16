import { db } from "../lib/db.js";
import { addDays, isoDate, startOfUtcDay } from "../lib/dates.js";

/**
 * Home-screen operations dashboard.
 *
 * Each KPI card issues its own query, then the legacy detail table hydrates
 * the full visit-group graph on top: a single render is roughly 20 sequential
 * round trips against the primary, with no statement timeout and whatever
 * date window the caller passes.
 */

function isoWeekStart(value: Date): Date {
  const day = startOfUtcDay(value);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday-based
  return addDays(day, -weekday);
}

export async function operationsDashboard(organizationId: string, start: Date, end: Date) {
  const orgVisit = { visitGroup: { visitSet: { organizationId } } } as const;
  // "This week" is the 7 days ending at the requested end date, which rarely
  // lines up with the calendar week label the UI puts on the card.
  const weekAgo = addDays(end, -7);

  const activePatients = await db.patient.count({ where: { organizationId, active: true, deletedAt: null } });
  // Exact lifetime count over the whole visit table for the "total visits" card.
  const totalVisits = await db.visit.count({ where: orgVisit });
  const visitsScheduledThisWeek = await db.visit.count({
    where: { ...orgVisit, scheduledStart: { gte: weekAgo, lt: end }, status: { not: "CANCELLED" } },
  });
  const visitsCompletedThisWeek = await db.visit.count({
    where: { ...orgVisit, completedAt: { gte: weekAgo, lt: end } },
  });
  const unsignedNotes = await db.clinicalNote.count({
    where: { status: { not: "SIGNED" }, visit: orgVisit },
  });
  const claimsAwaitingSubmission = await db.claim.count({
    where: { organizationId, status: { in: ["DRAFT", "READY"] } },
  });
  const rejectedClaims = await db.claim.count({ where: { organizationId, status: "REJECTED" } });
  const openBalance = await db.claim.aggregate({
    where: { organizationId, status: { notIn: ["PAID", "VOIDED"] } },
    _sum: { balanceAmount: true },
  });
  const unapplied = await db.payment.aggregate({ where: { organizationId }, _sum: { unappliedAmount: true } });
  // Revenue on this card is the sum of claim totals *created* in the window.
  // The revenue report prices visits from charges/rates and month-close
  // accrues by service date, so the three figures rarely agree.
  const claimRevenue = await db.claim.aggregate({
    where: { organizationId, createdAt: { gte: start, lt: end } },
    _sum: { totalAmount: true },
  });
  const completedAllTime = await db.visit.count({ where: { ...orgVisit, status: "COMPLETED" } });
  const withSignedNote = await db.visit.count({
    where: { ...orgVisit, status: "COMPLETED", notes: { some: { status: "SIGNED" } } },
  });

  // Last 8 ISO weeks, one count per week.
  const currentWeek = isoWeekStart(end);
  const weeklyVolume: Array<{ weekOf: string; visits: number }> = [];
  for (let i = 7; i >= 0; i -= 1) {
    const weekStart = addDays(currentWeek, -7 * i);
    const visits = await db.visit.count({
      where: { ...orgVisit, scheduledStart: { gte: weekStart, lt: addDays(weekStart, 7) }, status: { not: "CANCELLED" } },
    });
    weeklyVolume.push({ weekOf: isoDate(weekStart), visits });
  }

  const visitsMissingCharges = await db.visit.count({
    where: { ...orgVisit, status: "COMPLETED", charges: { none: {} } },
  });
  const staleAuthorizations = await db.authorization.count({
    where: { status: "ACTIVE", effectiveTo: { lt: end }, visitSets: { some: { organizationId } } },
  });
  const unmatchedRemittanceLines = await db.remittanceLine.count({
    where: { status: "UNMATCHED", file: { organizationId } },
  });

  // The legacy dashboard table below the cards still consumes these rows, so
  // the endpoint returns the fully hydrated group graph alongside the KPIs.
  const visitGroups = await db.visitGroup.findMany({
    where: { visitSet: { organizationId }, scheduledDate: { gte: start, lt: end }, deletedAt: null },
    include: { visits: { include: { notes: true } }, branch: true, visitSet: { include: { patient: true, authorization: true } } },
    orderBy: { scheduledDate: "asc" },
  });
  // Counts completed VisitGroups and labels them "completed visits"; multi-visit
  // groups make this run lower than the visit-level counts above.
  const completedVisits = visitGroups.filter((group) => group.status === "COMPLETED").length;
  const unsigned = visitGroups.filter((group) => group.documentationStatus !== "SIGNED").length;

  return {
    kpis: {
      activePatients,
      totalVisits,
      visitsScheduledThisWeek,
      visitsCompletedThisWeek,
      unsignedNotes,
      claimsAwaitingSubmission,
      rejectedClaims,
      openBalanceTotal: Number(openBalance._sum.balanceAmount ?? 0),
      unappliedCash: Number(unapplied._sum.unappliedAmount ?? 0),
      revenue: Number(claimRevenue._sum.totalAmount ?? 0),
      docComplianceRate: completedAllTime === 0 ? 1 : withSignedNote / completedAllTime,
    },
    weeklyVolume,
    exceptions: { visitsMissingCharges, staleAuthorizations, unmatchedRemittanceLines },
    completedVisits,
    unsigned,
    rows: visitGroups,
  };
}

/** Patient header badge counts; the header fires all four on every page view. */
export async function patientHeaderCounts(patientId: string) {
  const all = await db.visit.count({ where: { patientId } });
  const completed = await db.visit.count({ where: { patientId, status: "COMPLETED" } });
  const upcoming = await db.visit.count({ where: { patientId, status: "SCHEDULED", scheduledStart: { gte: new Date() } } });
  const billable = await db.visit.count({
    where: { patientId, status: "COMPLETED", notes: { some: { status: "SIGNED" } }, charges: { none: {} } },
  });
  return { all, completed, upcoming, billable };
}
