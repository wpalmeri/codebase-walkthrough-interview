import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { addDays, startOfUtcDay } from "../lib/dates.js";

const DEFAULT_DAILY_VISIT_CAPACITY = 7;

/**
 * Clinician capacity check used by the scheduling drawer. Counts scheduled
 * visits per clinician per day. Note the definition drift: capacity counts
 * SCHEDULED + IN_PROGRESS but not COMPLETED, so a clinician who finished
 * three morning visits shows more remaining capacity as the day progresses.
 */
export async function clinicianDayCapacity(context: RequestContext, clinicianId: string, date: Date) {
  const dayStart = startOfUtcDay(date);
  const dayEnd = addDays(dayStart, 1);
  const booked = await db.visit.count({
    where: {
      clinicianId,
      scheduledStart: { gte: dayStart, lt: dayEnd },
      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      deletedAt: null,
    },
  });
  return {
    clinicianId,
    date: dayStart.toISOString().slice(0, 10),
    booked,
    capacity: DEFAULT_DAILY_VISIT_CAPACITY,
    available: Math.max(0, DEFAULT_DAILY_VISIT_CAPACITY - booked),
  };
}

export async function branchCapacitySummary(context: RequestContext, branchId: string, date: Date) {
  const clinicians = await db.user.findMany({
    where: { organizationId: context.organizationId, role: "CLINICIAN", active: true, branchAccess: { some: { branchId } } },
  });
  const rows = [];
  for (const clinician of clinicians) {
    rows.push({ name: clinician.displayName, ...(await clinicianDayCapacity(context, clinician.id, date)) });
  }
  return rows;
}
