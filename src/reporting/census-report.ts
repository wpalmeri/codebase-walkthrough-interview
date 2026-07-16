import { db } from "../lib/db.js";
import { isoDate, serviceDateOf } from "../lib/dates.js";

/**
 * Monthly patient census.
 *
 * `census` is the headline number: distinct patients with a completed visit in
 * the month. The three legacy columns are earlier census definitions that are
 * still wired into dashboards, so all four ship side by side.
 */
export async function monthlyPatientCensus(organizationId: string, start: Date, end: Date) {
  const activeFlag = await db.patient.count({ where: { organizationId, active: true, deletedAt: null } });
  const withVisits = await db.patient.findMany({
    where: { organizationId, visits: { some: { scheduledStart: { gte: start, lt: end }, status: { not: "CANCELLED" } } } },
    select: { id: true },
  });
  const withCompletedGroups = await db.patient.findMany({
    where: { organizationId, visitSets: { some: { groups: { some: { scheduledDate: { gte: start, lt: end }, status: "COMPLETED" } } } } },
    select: { id: true },
  });

  const censusPatients = await db.patient.findMany({
    where: { organizationId, visits: { some: { status: "COMPLETED", completedAt: { gte: start, lt: end } } } },
    select: { id: true },
  });

  const completedVisits = await db.visit.findMany({
    where: { status: "COMPLETED", completedAt: { gte: start, lt: end }, deletedAt: null, visitGroup: { visitSet: { organizationId } } },
    select: { patientId: true, actualStart: true, scheduledStart: true },
  });
  // The visits column counts unique (patient, service date) pairs: two visits
  // to the same patient on one day are one "visit" here, so this runs lower
  // than the dashboard and productivity visit counts for the same window.
  const patientDays = new Set(completedVisits.map((visit) => `${visit.patientId}:${isoDate(serviceDateOf(visit))}`));

  return {
    window: { start, end },
    census: censusPatients.length,
    visits: patientDays.size,
    activeFlag,
    patientsWithVisits: withVisits.length,
    patientsWithCompletedVisitGroups: withCompletedGroups.length,
  };
}
