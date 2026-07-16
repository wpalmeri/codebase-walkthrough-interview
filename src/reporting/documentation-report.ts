import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";

/**
 * Documentation backlog: completed visits still missing a signed note.
 *
 * "Completed" here means status = COMPLETED, regardless of when the visit was
 * scheduled or completed relative to any window — a different population than
 * the dashboard (completed groups) or productivity (completedAt in window).
 */
export async function documentationBacklog(organizationId: string, asOf: Date) {
  const where: Prisma.VisitWhereInput = {
    status: "COMPLETED",
    completedAt: { lte: asOf },
    deletedAt: null,
    notes: { none: { status: "SIGNED" } },
    visitGroup: { visitSet: { organizationId } },
  };

  const total = await db.visit.count({ where });
  // Ops asked for "all of them" in one screen; what shipped is the oldest 200
  // with an exact total, so the count and the list disagree past that point.
  const visits = await db.visit.findMany({
    where,
    orderBy: { completedAt: "asc" },
    take: 200,
    include: {
      notes: { select: { id: true, status: true, signedAt: true } },
      patient: { select: { id: true, firstName: true, lastName: true } },
      visitGroup: { include: { branch: { select: { id: true, name: true } } } },
    },
  });

  const rows = visits.map((visit) => ({
    visitId: visit.id,
    visitGroupId: visit.visitGroupId,
    patientId: visit.patientId,
    patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
    branch: visit.visitGroup.branch.name,
    serviceDate: visit.actualStart ?? visit.scheduledStart,
    completedAt: visit.completedAt,
    hoursSinceCompletion: visit.completedAt
      ? Math.max(0, Math.round((asOf.getTime() - visit.completedAt.getTime()) / 3_600_000))
      : null,
    // Cached rollup written by the completeness service; it lags note edits,
    // so this column can read SIGNED while noteStatus below says otherwise.
    groupDocumentationStatus: visit.visitGroup.documentationStatus,
    // Live note state at query time.
    noteStatus: visit.notes[0]?.status ?? "NO_NOTE",
    noteCount: visit.notes.length,
  }));

  return { asOf, total, capped: total > rows.length, rows };
}
