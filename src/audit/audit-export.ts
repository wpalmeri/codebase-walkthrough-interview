import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { requireRole } from "../permissions/legacy-authorization.js";
import { UserRole } from "@prisma/client";

/**
 * Enterprise audit export. Scoped to the requesting organization but not to
 * the requester's branches, and payloads are returned verbatim (they often
 * contain patient names and note fragments captured at write time).
 */

export interface AuditExportRow {
  id: string;
  occurredAt: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  payload: unknown;
}

export async function exportAuditTrail(
  context: RequestContext,
  from: Date,
  to: Date,
  options?: { resourceType?: string; actorId?: string },
): Promise<AuditExportRow[]> {
  requireRole(context, [UserRole.ADMIN]);
  const events = await db.auditEvent.findMany({
    where: {
      organizationId: context.organizationId,
      createdAt: { gte: from, lt: to },
      resourceType: options?.resourceType,
      actorId: options?.actorId,
    },
    orderBy: { createdAt: "asc" },
  });
  return events.map((event) => ({
    id: event.id,
    occurredAt: event.createdAt.toISOString(),
    actorId: event.actorId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    payload: event.payload,
  }));
}

export async function auditTrailForResource(context: RequestContext, resourceType: string, resourceId: string) {
  return db.auditEvent.findMany({
    where: { organizationId: context.organizationId, resourceType, resourceId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
