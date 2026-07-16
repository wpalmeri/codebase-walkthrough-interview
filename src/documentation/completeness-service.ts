import { db } from "../lib/db.js";

/**
 * Documentation completeness.
 *
 * The truth about whether a visit is documented lives on ClinicalNote rows;
 * VisitGroup.documentationStatus is a cache written here and read by billing
 * readiness, reports, and workflows. Recomputes update the group only — the
 * VisitSet has no documentation rollup, and nothing recomputes when a note
 * is edited after signing or when a visit moves groups.
 */

export async function recomputeGroupDocumentationStatus(visitGroupId: string): Promise<string> {
  const visits = await db.visit.findMany({
    where: { visitGroupId, deletedAt: null, status: { not: "CANCELLED" } },
    include: { notes: true },
  });

  let status = "MISSING";
  if (visits.length > 0) {
    const documented = visits.filter((visit) => visit.notes.length > 0);
    const signed = visits.filter((visit) => visit.notes.some((note) => note.status === "SIGNED"));
    if (signed.length === visits.length) status = "SIGNED";
    else if (documented.length > 0) status = "DRAFT";
  }

  await db.visitGroup.update({ where: { id: visitGroupId }, data: { documentationStatus: status } });
  return status;
}

export interface CompletenessRow {
  visitId: string;
  patientName: string;
  clinicianId: string | null;
  branchName: string;
  completedAt: Date | null;
  noteStatus: "MISSING" | "DRAFT" | "SIGNED";
  groupCachedStatus: string;
  hoursSinceCompletion: number | null;
}

/**
 * Documentation backlog for the ops screen: completed visits without a
 * signed note. Reads live note rows, so it routinely disagrees with the
 * cached group status other screens show.
 */
export async function documentationBacklogRows(organizationId: string, limit = 100): Promise<CompletenessRow[]> {
  const visits = await db.visit.findMany({
    where: {
      status: "COMPLETED",
      deletedAt: null,
      visitGroup: { visitSet: { organizationId } },
      notes: { none: { status: "SIGNED" } },
    },
    include: {
      patient: true,
      notes: true,
      visitGroup: { include: { branch: true } },
    },
    orderBy: { completedAt: "asc" },
    take: limit,
  });

  const now = Date.now();
  return visits.map((visit) => ({
    visitId: visit.id,
    patientName: `${visit.patient.lastName}, ${visit.patient.firstName}`,
    clinicianId: visit.clinicianId,
    branchName: visit.visitGroup.branch.name,
    completedAt: visit.completedAt,
    noteStatus: visit.notes.length === 0 ? "MISSING" : "DRAFT",
    groupCachedStatus: visit.visitGroup.documentationStatus,
    hoursSinceCompletion: visit.completedAt ? Math.round((now - visit.completedAt.getTime()) / 3_600_000) : null,
  }));
}

/** Completeness ratio used on the visit-set card and by the AI context builder. */
export async function setDocumentationSummary(visitSetId: string) {
  const groups = await db.visitGroup.findMany({ where: { visitSetId, deletedAt: null } });
  const signedGroups = groups.filter((group) => group.documentationStatus === "SIGNED").length;
  return {
    totalGroups: groups.length,
    signedGroups,
    percentComplete: groups.length > 0 ? Math.round((signedGroups / groups.length) * 100) : 0,
  };
}
