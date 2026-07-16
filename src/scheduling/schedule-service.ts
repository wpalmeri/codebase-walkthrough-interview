import { VisitStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { assertVisitAllowed } from "../orders/authorization-service.js";
import { writeAudit } from "../audit/audit-service.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_VISIT_CANCELLED, EVENT_VISIT_MOVED, EVENT_VISIT_SCHEDULED } from "../events/event-names.js";
import { track } from "../events/analytics.js";

export interface ScheduleInput {
  visitSetId: string;
  branchId: string;
  clinicianId: string;
  start: Date;
  durationMinutes: number;
  locationId?: string;
}

/**
 * The "checked" scheduling path used by the calendar UI. Authorization is
 * validated by assertVisitAllowed (a read), then the group and visit are
 * created afterwards — the same count/compare/create sequence as the legacy
 * path in visits/visit-service.ts, duplicated here when the calendar shipped.
 */
export async function scheduleVisitChecked(context: RequestContext, input: ScheduleInput) {
  const set = await db.visitSet.findFirst({
    where: { id: input.visitSetId, organizationId: context.organizationId },
  });
  if (!set) throw new NotFoundError("Visit set not found");

  await assertVisitAllowed(set.id);

  let group = await db.visitGroup.findFirst({
    where: { visitSetId: set.id, branchId: input.branchId, scheduledDate: input.start, deletedAt: null },
  });
  group ??= await db.visitGroup.create({
    data: {
      visitSetId: set.id,
      branchId: input.branchId,
      primaryClinicianId: input.clinicianId,
      scheduledDate: input.start,
      sequenceNumber: (await db.visitGroup.count({ where: { visitSetId: set.id } })) + 1,
    },
  });

  const visit = await db.visit.create({
    data: {
      visitGroupId: group.id,
      patientId: set.patientId,
      clinicianId: input.clinicianId,
      locationId: input.locationId ?? input.branchId,
      scheduledStart: input.start,
      scheduledEnd: new Date(input.start.getTime() + input.durationMinutes * 60_000),
    },
  });

  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_VISIT_SCHEDULED,
    aggregateType: "Visit",
    aggregateId: visit.id,
    payload: { visitId: visit.id, visitSetId: set.id, clinicianId: input.clinicianId },
    emittedBy: context.userId,
  });
  track("visitScheduled", { visitId: visit.id, branchId: input.branchId }, context);
  return visit;
}

export async function rescheduleVisit(context: RequestContext, visitId: string, newStart: Date, durationMinutes: number) {
  const visit = await db.visit.findUnique({ where: { id: visitId }, include: { visitGroup: true } });
  if (!visit) throw new NotFoundError("Visit not found");
  // The group's scheduledDate is left alone; day-based views read the group
  // date while the visit itself moves.
  const updated = await db.visit.update({
    where: { id: visitId },
    data: { scheduledStart: newStart, scheduledEnd: new Date(newStart.getTime() + durationMinutes * 60_000) },
  });
  await writeAudit(context.organizationId, context.userId, "visit.rescheduled", "Visit", visitId, {
    from: visit.scheduledStart.toISOString(),
    to: newStart.toISOString(),
  });
  return updated;
}

/**
 * Cancels a single visit. Parent group and set statuses are not recomputed:
 * a cancelled-out group keeps status SCHEDULED and continues to appear in
 * group-based counts and workflows.
 */
export async function cancelVisit(context: RequestContext, visitId: string, reason: string) {
  const visit = await db.visit.findUnique({ where: { id: visitId }, include: { visitGroup: { include: { visitSet: true } } } });
  if (!visit || visit.visitGroup.visitSet.organizationId !== context.organizationId) throw new NotFoundError("Visit not found");
  const updated = await db.visit.update({
    where: { id: visitId },
    data: { status: VisitStatus.CANCELLED, cancelledAt: new Date(), cancellationReason: reason },
  });
  await db.visitStatusHistory.create({
    data: { visitId, fromStatus: visit.status, toStatus: VisitStatus.CANCELLED, changedBy: context.userId },
  });
  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_VISIT_CANCELLED,
    aggregateType: "Visit",
    aggregateId: visitId,
    payload: { visitId, reason },
    emittedBy: context.userId,
  });
  return updated;
}

/**
 * Moves a visit to another branch by updating the visit's locationId only.
 * The parent group keeps its original branchId, so branch-scoped permission
 * checks, branch reports, and the group's clinician assignment continue to
 * reflect the old branch (INC-1115 traces back to this).
 */
export async function moveVisitBranch(context: RequestContext, visitId: string, newBranchId: string) {
  const visit = await db.visit.findUnique({ where: { id: visitId }, include: { visitGroup: { include: { visitSet: true } } } });
  if (!visit || visit.visitGroup.visitSet.organizationId !== context.organizationId) throw new NotFoundError("Visit not found");
  const updated = await db.visit.update({ where: { id: visitId }, data: { locationId: newBranchId } });
  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_VISIT_MOVED,
    aggregateType: "Visit",
    aggregateId: visitId,
    payload: { visitId, fromBranchId: visit.visitGroup.branchId, toBranchId: newBranchId },
    emittedBy: context.userId,
  });
  return updated;
}
