import { db } from "../lib/db.js";

export async function writeAudit(organizationId: string, actorId: string | null, action: string, resourceType: string, resourceId: string, payload?: object) {
  return db.auditEvent.create({ data: { organizationId, actorId, action, resourceType, resourceId, payload } });
}

export async function exportAudit(organizationId: string, from: Date, to: Date) {
  return db.auditEvent.findMany({ where: { organizationId, createdAt: { gte: from, lt: to } }, orderBy: { createdAt: "asc" } });
}
