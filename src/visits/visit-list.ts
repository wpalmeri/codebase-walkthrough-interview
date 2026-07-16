import type { Prisma, VisitStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { canAccessBranch } from "../permissions/legacy-authorization.js";

export interface VisitListFilters {
  status?: VisitStatus;
  branchId?: string;
  patientId?: string;
  clinicianId?: string;
  serviceType?: string;
  from?: Date;
  to?: Date;
  documentationStatus?: string;
}

/**
 * Main visit list. The exact total is computed before the page (and before
 * the in-memory branch filter, so the total can exceed the visible rows).
 * Includes pull notes and charge lines for every row to power the list's
 * status chips.
 */
export async function listVisits(context: RequestContext, page = 1, pageSize = 25, filters: VisitListFilters = {}) {
  const where: Prisma.VisitWhereInput = {
    visitGroup: {
      visitSet: { organizationId: context.organizationId },
      branchId: filters.branchId,
      documentationStatus: filters.documentationStatus,
    },
    deletedAt: null,
    status: filters.status,
    patientId: filters.patientId,
    clinicianId: filters.clinicianId,
    scheduledStart: filters.from || filters.to ? { gte: filters.from, lt: filters.to } : undefined,
  };
  if (filters.serviceType) {
    where.OR = [
      { serviceType: filters.serviceType },
      { serviceType: null, visitGroup: { visitSet: { organizationId: context.organizationId, serviceType: filters.serviceType } } },
    ];
  }

  const total = await db.visit.count({ where });
  const visits = await db.visit.findMany({
    where,
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: { scheduledStart: "desc" },
    include: {
      patient: { include: { profile: true } },
      visitGroup: { include: { visitSet: { include: { authorization: true } }, branch: true } },
      notes: true,
      charges: { include: { lines: true } },
    },
  });

  const visible = [];
  for (const visit of visits) {
    if (canAccessBranch(context, visit.visitGroup.branchId)) visible.push(visit);
  }
  return { page, pageSize, total, data: visible };
}

/** Compact rows for the dashboard's recent-activity feed. */
export async function recentVisitActivity(context: RequestContext, limit = 12) {
  const visits = await db.visit.findMany({
    where: { visitGroup: { visitSet: { organizationId: context.organizationId } }, deletedAt: null, status: { in: ["COMPLETED", "IN_PROGRESS", "CANCELLED"] } },
    orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { scheduledStart: "desc" }],
    take: limit,
    include: {
      patient: true,
      visitGroup: { include: { branch: true, visitSet: true } },
      notes: { select: { status: true } },
    },
  });
  return visits.map((visit) => ({
    id: visit.id,
    patientName: `${visit.patient.lastName}, ${visit.patient.firstName}`,
    branchName: visit.visitGroup.branch.name,
    serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
    status: visit.status,
    when: visit.completedAt ?? visit.scheduledStart,
    signed: visit.notes.some((note) => note.status === "SIGNED"),
  }));
}
