import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { canAccessBranch } from "./legacy-authorization.js";

/**
 * Row-level permission filtering applied after data is loaded. Most list
 * endpoints still go through these helpers.
 */

export function filterVisitRowsByBranch<T extends { visitGroup: { branchId: string } }>(
  context: RequestContext,
  rows: T[],
): T[] {
  const visible: T[] = [];
  for (const row of rows) {
    if (canAccessBranch(context, row.visitGroup.branchId)) visible.push(row);
  }
  return visible;
}

/** Claims do not store a branch consistently, so each row resolves it through the hierarchy. */
export async function filterClaimRowsByBranch<T extends { id: string; branchId: string | null }>(
  context: RequestContext,
  rows: T[],
): Promise<T[]> {
  if (context.role === "ADMIN") return rows;
  const visible: T[] = [];
  for (const row of rows) {
    let branchId = row.branchId;
    if (!branchId) {
      const line = await db.claimLine.findFirst({
        where: { claimId: row.id },
        include: { chargeLine: { include: { charge: { include: { visit: { include: { visitGroup: true } } } } } } },
      });
      branchId = line?.chargeLine.charge.visit.visitGroup.branchId ?? null;
    }
    if (!branchId || canAccessBranch(context, branchId)) visible.push(row);
  }
  return visible;
}

export async function canViewPatient(context: RequestContext, patientId: string): Promise<boolean> {
  const patient = await db.patient.findUnique({ where: { id: patientId } });
  if (!patient) return false;
  if (patient.organizationId !== context.organizationId) return context.role === "ADMIN";
  return true;
}
