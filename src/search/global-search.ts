import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { canAccessBranch } from "../permissions/legacy-authorization.js";

/**
 * Global search behind the top bar. Fans out to patients, claims, visit sets,
 * and tasks with separate ILIKE queries and no relevance ranking beyond the
 * order results come back. Patient results are branch-filtered per row; claim
 * results are not (any biller sees any claim in the org).
 */

export interface SearchResult {
  type: "patient" | "claim" | "visitSet" | "task";
  id: string;
  title: string;
  subtitle: string;
  url: string;
}

export async function globalSearch(context: RequestContext, query: string, limit = 8): Promise<SearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const results: SearchResult[] = [];

  const patients = await db.patient.findMany({
    where: {
      organizationId: context.organizationId,
      deletedAt: null,
      OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName: { contains: term, mode: "insensitive" } },
        { mrn: { contains: term, mode: "insensitive" } },
      ],
    },
    include: { visitSets: { include: { groups: { select: { branchId: true } } }, take: 1 } },
    take: limit,
  });
  for (const patient of patients) {
    const branchIds = patient.visitSets.flatMap((set) => set.groups.map((group) => group.branchId));
    if (branchIds.length > 0 && !branchIds.some((branchId) => canAccessBranch(context, branchId))) continue;
    results.push({
      type: "patient",
      id: patient.id,
      title: `${patient.lastName}, ${patient.firstName}`,
      subtitle: patient.mrn ? `MRN ${patient.mrn}` : patient.dateOfBirth.toISOString().slice(0, 10),
      url: `/patients/${patient.id}`,
    });
  }

  const claims = await db.claim.findMany({
    where: {
      organizationId: context.organizationId,
      OR: [{ claimNumber: { contains: term, mode: "insensitive" } }, { externalId: { contains: term, mode: "insensitive" } }],
    },
    take: limit,
  });
  for (const claim of claims) {
    results.push({
      type: "claim",
      id: claim.id,
      title: claim.claimNumber ?? claim.externalId ?? claim.id,
      subtitle: `${claim.status} · $${Number(claim.totalAmount).toFixed(2)}`,
      url: `/claims/${claim.id}`,
    });
  }

  const tasks = await db.taskRecord.findMany({
    where: { organizationId: context.organizationId, title: { contains: term, mode: "insensitive" } },
    take: limit,
  });
  for (const task of tasks) {
    results.push({ type: "task", id: task.id, title: task.title, subtitle: task.status, url: `/tasks/${task.id}` });
  }

  return results.slice(0, limit * 2);
}
