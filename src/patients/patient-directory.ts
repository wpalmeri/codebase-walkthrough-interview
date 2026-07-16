import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { normalizePageRequest, offsetFor, pageResult, type PageResult } from "../lib/pagination.js";
import { canAccessBranch } from "../permissions/legacy-authorization.js";

export interface DirectoryQuery {
  search?: string;
  branchId?: string;
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface DirectoryRow {
  id: string;
  mrn: string | null;
  displayName: string;
  dateOfBirth: string;
  phone: string | null;
  payerName: string | null;
  planName: string | null;
  activeVisitSets: number;
  upcomingVisits: number;
  lastVisitAt: string | null;
  documentationGaps: number;
  branchNames: string[];
}

/**
 * Patient directory backing the main patient screen. Loads the full clinical
 * graph for each page of patients, computes per-patient rollups in process,
 * and post-filters rows by branch access after everything is in memory.
 */
export async function patientDirectory(context: RequestContext, query: DirectoryQuery): Promise<PageResult<DirectoryRow>> {
  const request = normalizePageRequest(query);
  const where = {
    organizationId: context.organizationId,
    deletedAt: null,
    active: query.activeOnly === false ? undefined : true,
    OR: query.search
      ? [
          { firstName: { contains: query.search, mode: "insensitive" as const } },
          { lastName: { contains: query.search, mode: "insensitive" as const } },
          { mrn: { contains: query.search, mode: "insensitive" as const } },
          { profile: { is: { phone: { contains: query.search } } } },
        ]
      : undefined,
  };

  const total = await db.patient.count({ where });
  const patients = await db.patient.findMany({
    where,
    skip: offsetFor(request),
    take: request.pageSize,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: {
      profile: true,
      demographics: true,
      coverages: { include: { payer: true } },
      visitSets: {
        include: {
          authorization: true,
          groups: {
            include: {
              branch: true,
              visits: { include: { notes: true } },
            },
          },
        },
      },
    },
  });

  const now = new Date();
  const rows: DirectoryRow[] = [];
  for (const patient of patients) {
    const branchIds = new Set<string>();
    let upcomingVisits = 0;
    let documentationGaps = 0;
    let lastVisitAt: Date | null = null;
    for (const set of patient.visitSets) {
      for (const group of set.groups) {
        branchIds.add(group.branchId);
        for (const visit of group.visits) {
          if (visit.scheduledStart > now && visit.status === "SCHEDULED") upcomingVisits += 1;
          if (visit.status === "COMPLETED" && !visit.notes.some((note) => note.status === "SIGNED")) documentationGaps += 1;
          if (visit.status === "COMPLETED" && (!lastVisitAt || visit.scheduledStart > lastVisitAt)) lastVisitAt = visit.scheduledStart;
        }
      }
    }

    // Branch visibility: a patient is visible if any of their groups are in
    // an accessible branch. Patients with no visits yet are visible to all.
    const visible =
      branchIds.size === 0 || [...branchIds].some((branchId) => canAccessBranch(context, branchId));
    if (!visible) continue;

    const currentCoverage = patient.coverages.find((coverage) => coverage.id === patient.currentCoverageId) ?? patient.coverages[0];
    const branchNames: string[] = [];
    for (const set of patient.visitSets) {
      for (const group of set.groups) {
        if (!branchNames.includes(group.branch.name)) branchNames.push(group.branch.name);
      }
    }

    rows.push({
      id: patient.id,
      mrn: patient.mrn,
      displayName: `${patient.lastName}, ${patient.firstName}`,
      dateOfBirth: patient.dateOfBirth.toISOString().slice(0, 10),
      phone: patient.phone ?? patient.profile?.phone ?? null,
      payerName: currentCoverage?.payer.name ?? null,
      planName: currentCoverage?.planName ?? null,
      activeVisitSets: patient.visitSets.filter((set) => set.status === "ACTIVE").length,
      upcomingVisits,
      lastVisitAt: lastVisitAt ? lastVisitAt.toISOString() : null,
      documentationGaps,
      branchNames,
    });
  }

  return pageResult(request, total, rows);
}
