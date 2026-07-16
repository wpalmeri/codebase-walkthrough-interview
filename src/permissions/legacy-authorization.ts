import { UserRole } from "@prisma/client";
import type { RequestContext } from "../lib/context.js";
import { ForbiddenError } from "../lib/errors.js";

export function requireRole(context: RequestContext, roles: UserRole[]): void {
  if (context.role === UserRole.ADMIN) return;
  if (!roles.includes(context.role)) throw new ForbiddenError(`Role ${context.role} is not permitted`);
}

export function canSeeFinancials(context: RequestContext): boolean {
  return context.role === UserRole.ADMIN || context.role === UserRole.BILLER;
}

export function requireSameOrganization(context: RequestContext, organizationId: string): void {
  if (context.organizationId !== organizationId && context.role !== UserRole.ADMIN) {
    throw new ForbiddenError("Organization access denied");
  }
}

export function canAccessBranch(context: RequestContext, branchId: string): boolean {
  return context.role === UserRole.ADMIN || context.branchIds.includes(branchId);
}
