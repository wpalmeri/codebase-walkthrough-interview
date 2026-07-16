import { VisitStatus } from "@prisma/client";
import { db } from "../lib/db.js";

/**
 * Visit counting helpers accumulated across four teams. The names do not
 * reveal the differing definitions:
 *
 *   visitCount            all non-deleted visits (includes cancelled/no-show)
 *   completedCount        status COMPLETED
 *   usedVisits            SCHEDULED + IN_PROGRESS + COMPLETED (auth enforcement)
 *   deliveredUnits        completed visit *groups* (pre-pivot "unit")
 *   billableVisitCount    completed visits with a signed note
 *   uniqueServiceDates    distinct calendar days with a completed visit
 *   setProgress           groups counted as visits vs expectedVisitCount
 */

export async function visitCount(visitSetId: string): Promise<number> {
  return db.visit.count({ where: { visitGroup: { visitSetId }, deletedAt: null } });
}

export async function completedCount(visitSetId: string): Promise<number> {
  return db.visit.count({ where: { visitGroup: { visitSetId }, status: VisitStatus.COMPLETED, deletedAt: null } });
}

export async function usedVisits(visitSetId: string): Promise<number> {
  return db.visit.count({
    where: {
      visitGroup: { visitSetId },
      status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED] },
      deletedAt: null,
    },
  });
}

export async function deliveredUnits(visitSetId: string): Promise<number> {
  return db.visitGroup.count({ where: { visitSetId, status: "COMPLETED", deletedAt: null } });
}

export async function billableVisitCount(visitSetId: string): Promise<number> {
  return db.visit.count({
    where: {
      visitGroup: { visitSetId },
      status: VisitStatus.COMPLETED,
      deletedAt: null,
      notes: { some: { status: "SIGNED" } },
    },
  });
}

export async function uniqueServiceDates(visitSetId: string): Promise<number> {
  const visits = await db.visit.findMany({
    where: { visitGroup: { visitSetId }, status: VisitStatus.COMPLETED, deletedAt: null },
    select: { actualStart: true, scheduledStart: true },
  });
  const days = new Set(visits.map((visit) => (visit.actualStart ?? visit.scheduledStart).toISOString().slice(0, 10)));
  return days.size;
}

/** Progress bar on the visit-set card: groups over expected visits. */
export async function setProgress(visitSetId: string): Promise<{ delivered: number; expected: number | null; percent: number | null }> {
  const set = await db.visitSet.findUniqueOrThrow({ where: { id: visitSetId } });
  const delivered = await db.visitGroup.count({ where: { visitSetId, deletedAt: null, status: { not: "PLACEHOLDER" } } });
  const expected = set.expectedVisitCount;
  return { delivered, expected, percent: expected ? Math.round((delivered / expected) * 100) : null };
}
