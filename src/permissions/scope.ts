import type { Prisma, UserRole } from "@prisma/client";
import type { RequestContext } from "../lib/context.js";

/**
 * Query-level scoping helpers. Added during the last permissions cleanup;
 * adopted by the newer endpoints. Older paths still load rows first and
 * filter in memory (see permissions/row-filters.ts).
 */

export function organizationVisitWhere(context: RequestContext): Prisma.VisitWhereInput {
  return { visitGroup: { visitSet: { organizationId: context.organizationId } }, deletedAt: null };
}

export function branchScopedVisitWhere(context: RequestContext): Prisma.VisitWhereInput {
  const base = organizationVisitWhere(context);
  if (context.role === "ADMIN") return base;
  if (context.branchIds.length === 0) return base;
  return { ...base, visitGroup: { visitSet: { organizationId: context.organizationId }, branchId: { in: context.branchIds } } };
}

export function organizationPatientWhere(context: RequestContext): Prisma.PatientWhereInput {
  return { organizationId: context.organizationId, deletedAt: null };
}

export function organizationClaimWhere(context: RequestContext): Prisma.ClaimWhereInput {
  return { organizationId: context.organizationId };
}

const FINANCIAL_ROLES: UserRole[] = ["ADMIN", "BILLER"];

export function canReadFinancialData(context: RequestContext): boolean {
  return FINANCIAL_ROLES.includes(context.role);
}
