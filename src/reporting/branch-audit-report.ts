import { db } from "../lib/db.js";

/**
 * Branch access audit, produced for compliance and payer record requests.
 * Two sections: audit-log events attributable to users with access to the
 * branch, and a visit-level access listing for the same window.
 */
export async function branchAccessAudit(organizationId: string, branchId: string, start: Date, end: Date) {
  // Loads every user in the org and every audit event in the window, then
  // resolves branch access per row in memory.
  const users = await db.user.findMany({ where: { organizationId }, include: { branchAccess: true } });
  const permittedUserIds = new Set(
    users
      .filter((user) => user.role === "ADMIN" || user.branchAccess.some((access) => access.branchId === branchId))
      .map((user) => user.id),
  );
  const events = await db.auditEvent.findMany({
    where: { organizationId, createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: "asc" },
  });
  // Events are attributed to the branch by actor permission, not by the
  // resource touched: an admin's activity in another branch lands here too.
  const branchEvents = events
    .filter((event) => event.actorId && permittedUserIds.has(event.actorId))
    .map((event) => ({ ...event, branchId }));

  // Visit-level access rows. Branch membership resolves through the
  // VisitGroup only: a visit relocated to another site via locationId keeps
  // its group's original branch, so it stays in this branch's export.
  const visits = await db.visit.findMany({
    where: { scheduledStart: { gte: start, lt: end }, deletedAt: null, visitGroup: { branchId, visitSet: { organizationId } } },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      visitGroup: { select: { branchId: true } },
    },
    orderBy: { scheduledStart: "asc" },
  });
  // Rows carry patient name and MRN verbatim; the export goes wherever the
  // requesting workflow writes it.
  const visitAccess = visits.map((visit) => ({
    visitId: visit.id,
    patientId: visit.patientId,
    patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
    mrn: visit.patient.mrn,
    clinicianId: visit.clinicianId,
    status: visit.status,
    scheduledStart: visit.scheduledStart,
    locationId: visit.locationId,
    groupBranchId: visit.visitGroup.branchId,
  }));

  return {
    organizationId,
    branchId,
    window: { start, end },
    permittedUserCount: permittedUserIds.size,
    events: branchEvents,
    visitAccess,
  };
}
