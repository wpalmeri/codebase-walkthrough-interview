import { VisitStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { completionValue } from "./completion-price.js";
import { recomputeGroupDocumentationStatus } from "../documentation/completeness-service.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_VISIT_COMPLETED } from "../events/event-names.js";
import { track } from "../events/analytics.js";
import { notifyCrmOfVisitActivity } from "../integrations/crm-sync.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("visits");

export interface ScheduleVisitInput {
  visitSetId: string;
  branchId: string;
  clinicianId: string;
  start: Date;
  durationMinutes: number;
}

export async function authorizationUsage(visitSetId: string) {
  const visitSet = await db.visitSet.findUnique({ include: { authorization: true }, where: { id: visitSetId } });
  if (!visitSet) throw new NotFoundError("Visit set not found");
  const usedVisits = await db.visit.count({
    where: { visitGroup: { visitSetId }, status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED] }, deletedAt: null },
  });
  return { usedVisits, maximum: visitSet.authorization?.maxVisits ?? null };
}

export async function scheduleVisit(context: RequestContext, input: ScheduleVisitInput) {
  const set = await db.visitSet.findFirst({ where: { id: input.visitSetId, organizationId: context.organizationId }, include: { authorization: true } });
  if (!set) throw new NotFoundError("Visit set not found");
  const usage = await authorizationUsage(set.id);
  if (usage.maximum !== null && usage.usedVisits >= usage.maximum) throw new ConflictError("Authorization visit limit reached");

  let group = await db.visitGroup.findFirst({ where: { visitSetId: set.id, branchId: input.branchId, scheduledDate: input.start } });
  group ??= await db.visitGroup.create({ data: {
    visitSetId: set.id, branchId: input.branchId, primaryClinicianId: input.clinicianId,
    scheduledDate: input.start, sequenceNumber: await db.visitGroup.count({ where: { visitSetId: set.id } }) + 1,
  } });
  return db.visit.create({ data: {
    visitGroupId: group.id, patientId: set.patientId, clinicianId: input.clinicianId, locationId: input.branchId,
    scheduledStart: input.start, scheduledEnd: new Date(input.start.getTime() + input.durationMinutes * 60_000),
  } });
}

/**
 * Completes a visit. Everything below runs inline in the request:
 * status write, history, group documentation recompute, set billing rollup,
 * expected-reimbursement pricing, audit, analytics, durable event, and a CRM
 * notification over HTTP. p95 for this endpoint tracks the CRM simulator's
 * latency, and a CRM failure after the status write leaves the side effects
 * half-applied.
 */
export async function completeVisit(context: RequestContext, visitId: string, actualStart: Date, actualEnd: Date) {
  const visit = await db.visit.findUnique({ include: { visitGroup: { include: { visitSet: true } } }, where: { id: visitId } });
  if (!visit || visit.visitGroup.visitSet.organizationId !== context.organizationId) throw new NotFoundError("Visit not found");

  const updated = await db.visit.update({ where: { id: visit.id }, data: { status: VisitStatus.COMPLETED, actualStart, actualEnd, completedAt: new Date() } });
  await db.visitStatusHistory.create({ data: { visitId, fromStatus: visit.status, toStatus: VisitStatus.COMPLETED, changedBy: context.userId } });

  const documentationStatus = await recomputeGroupDocumentationStatus(visit.visitGroupId);

  const groupsReady = await db.visitGroup.count({ where: { visitSetId: visit.visitGroup.visitSetId, billingStatus: "READY" } });
  const groupsTotal = await db.visitGroup.count({ where: { visitSetId: visit.visitGroup.visitSetId, deletedAt: null } });
  if (groupsReady === groupsTotal && groupsTotal > 0) {
    await db.visitSet.update({ where: { id: visit.visitGroup.visitSetId }, data: { billingStatus: "READY" } });
  }

  let expectedReimbursement: number | null = null;
  try {
    expectedReimbursement = (await completionValue(visitId)).amount;
  } catch (error) {
    log.warn({ visitId, error: error instanceof Error ? error.message : String(error) }, "completion pricing failed");
  }

  await db.auditEvent.create({ data: { organizationId: context.organizationId, actorId: context.userId, action: "visit.completed", resourceType: "Visit", resourceId: visitId } });
  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_VISIT_COMPLETED,
    aggregateType: "Visit",
    aggregateId: visitId,
    payload: { visitId, documentationStatus, expectedReimbursement },
    emittedBy: context.userId,
  });
  track("visitCompleted", { visitId, durationMinutes: Math.round((actualEnd.getTime() - actualStart.getTime()) / 60_000) }, context);

  await notifyCrmOfVisitActivity(context.organizationId, {
    type: "visit.completed",
    visitId,
    patientId: visit.patientId,
    completedAt: updated.completedAt?.toISOString(),
  });

  return { ...updated, expectedReimbursement, documentationStatus };
}

export async function startVisit(context: RequestContext, visitId: string) {
  const visit = await db.visit.findUnique({ where: { id: visitId }, include: { visitGroup: { include: { visitSet: true } } } });
  if (!visit || visit.visitGroup.visitSet.organizationId !== context.organizationId) throw new NotFoundError("Visit not found");
  if (visit.status !== VisitStatus.SCHEDULED) throw new ConflictError(`Cannot start a ${visit.status} visit`);
  const updated = await db.visit.update({ where: { id: visitId }, data: { status: VisitStatus.IN_PROGRESS, actualStart: new Date() } });
  await db.visitStatusHistory.create({ data: { visitId, fromStatus: visit.status, toStatus: VisitStatus.IN_PROGRESS, changedBy: context.userId } });
  return updated;
}

export async function markNoShow(context: RequestContext, visitId: string) {
  const visit = await db.visit.findUnique({ where: { id: visitId }, include: { visitGroup: { include: { visitSet: true } } } });
  if (!visit || visit.visitGroup.visitSet.organizationId !== context.organizationId) throw new NotFoundError("Visit not found");
  const updated = await db.visit.update({ where: { id: visitId }, data: { status: VisitStatus.NO_SHOW } });
  await db.visitStatusHistory.create({ data: { visitId, fromStatus: visit.status, toStatus: VisitStatus.NO_SHOW, changedBy: context.userId } });
  return updated;
}
