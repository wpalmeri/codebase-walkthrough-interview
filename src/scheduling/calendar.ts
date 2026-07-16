import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { addDays, startOfUtcDay } from "../lib/dates.js";
import { displayScheduledPrice } from "../pricing/scheduling-price.js";

/**
 * Week calendar for a branch. One query per clinician per day, plus a rate
 * lookup per visit so the calendar can show expected reimbursement — the
 * screen that made "why is the schedule slow" a standing support theme.
 */
export async function weekCalendar(context: RequestContext, branchId: string, weekStart: Date) {
  const start = startOfUtcDay(weekStart);
  const clinicians = await db.user.findMany({
    where: { organizationId: context.organizationId, role: "CLINICIAN", active: true },
    include: { clinicianProfile: true },
  });

  const days = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayStart = addDays(start, dayIndex);
    const dayEnd = addDays(dayStart, 1);
    const rows = [];
    for (const clinician of clinicians) {
      const visits = await db.visit.findMany({
        where: {
          clinicianId: clinician.id,
          scheduledStart: { gte: dayStart, lt: dayEnd },
          deletedAt: null,
          visitGroup: { branchId },
        },
        include: { patient: { include: { profile: true } }, visitGroup: { include: { visitSet: true } } },
        orderBy: { scheduledStart: "asc" },
      });
      const entries = [];
      for (const visit of visits) {
        let expectedRate: number | null = null;
        try {
          const price = await displayScheduledPrice(visit.id);
          expectedRate = Number(price.amount);
        } catch {
          expectedRate = null;
        }
        entries.push({
          visitId: visit.id,
          patientName: `${visit.patient.lastName}, ${visit.patient.firstName}`,
          serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
          start: visit.scheduledStart,
          end: visit.scheduledEnd,
          status: visit.status,
          expectedRate,
        });
      }
      if (entries.length > 0) {
        rows.push({ clinicianId: clinician.id, clinicianName: clinician.displayName, credential: clinician.clinicianProfile?.credential ?? null, visits: entries });
      }
    }
    days.push({ date: dayStart.toISOString().slice(0, 10), clinicians: rows });
  }
  return { branchId, weekStart: start.toISOString().slice(0, 10), days };
}
