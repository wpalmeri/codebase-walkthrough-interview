import { db } from "../lib/db.js";
import { minutesBetween } from "../lib/dates.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Per-clinician productivity. Loads the clinician roster, then runs a count
 * plus a hydrated visit query per clinician, plus one rate lookup per
 * completed visit for the revenue column.
 */
export async function clinicianProductivity(organizationId: string, start: Date, end: Date) {
  const clinicians = await db.user.findMany({
    where: { organizationId, role: "CLINICIAN", active: true },
    include: { clinicianProfile: true },
    orderBy: { displayName: "asc" },
  });

  const rows = [];
  for (const clinician of clinicians) {
    const scheduled = await db.visit.count({
      where: { clinicianId: clinician.id, scheduledStart: { gte: start, lt: end }, status: { not: "CANCELLED" }, deletedAt: null },
    });
    // Completed = completedAt landed in the window, regardless of current
    // status or when the visit was scheduled. The scheduled column above uses
    // scheduledStart, so the two columns cover different visit populations
    // and neither matches the dashboard's group-based count.
    const completedVisits = await db.visit.findMany({
      where: { clinicianId: clinician.id, completedAt: { gte: start, lt: end }, deletedAt: null },
      include: {
        patient: { include: { coverages: true } },
        visitGroup: { include: { visitSet: { select: { serviceType: true } } } },
        notes: { select: { status: true } },
      },
    });

    let minutes = 0;
    let revenue = 0;
    let pricedVisits = 0;
    let withSignedNote = 0;
    for (const visit of completedVisits) {
      if (visit.actualStart && visit.actualEnd) minutes += minutesBetween(visit.actualStart, visit.actualEnd);
      if (visit.notes.some((note) => note.status === "SIGNED")) withSignedNote += 1;
      // One findFirst per visit, priced against the patient's *current*
      // coverage and the rate effective at the window end — not the coverage
      // or rate in force on the service date.
      const coverage =
        visit.patient.coverages.find((item) => item.id === visit.patient.currentCoverageId) ?? visit.patient.coverages[0];
      const serviceType = visit.serviceType ?? visit.visitGroup.visitSet.serviceType;
      const rate = coverage
        ? await db.payerRate.findFirst({
            where: {
              serviceType,
              contract: { payerId: coverage.payerId, organizationId },
              effectiveFrom: { lte: end },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: end } }],
            },
            orderBy: { priority: "desc" },
          })
        : null;
      if (rate) {
        revenue += Number(rate.amount);
        pricedVisits += 1;
      }
    }

    const completed = completedVisits.length;
    rows.push({
      clinicianId: clinician.id,
      name: clinician.displayName,
      credential: clinician.clinicianProfile?.credential ?? clinician.credential ?? null,
      discipline: clinician.clinicianProfile?.discipline ?? null,
      scheduled,
      completed,
      minutesDelivered: minutes,
      revenuePerVisit: completed > 0 ? round2(revenue / completed) : 0,
      pricedVisits,
      docComplianceRate: completed > 0 ? round2(withSignedNote / completed) : 1,
    });
  }
  return rows;
}
