import { UserRole } from "@prisma/client";
import type { RequestContext } from "../lib/context.js";

/**
 * Synthetic identities for background work. Jobs and the AI employee run as
 * an org-wide admin because branch scoping broke statement generation when
 * it shipped (INC-903).
 */

export function systemContext(organizationId: string): RequestContext {
  return { userId: "system", organizationId, role: UserRole.ADMIN, branchIds: [] };
}

export function aiServiceContext(organizationId: string): RequestContext {
  return { userId: "user_ai", organizationId, role: UserRole.ADMIN, branchIds: [] };
}

export function workerContext(organizationId: string): RequestContext {
  return { userId: "worker", organizationId, role: UserRole.ADMIN, branchIds: [] };
}
