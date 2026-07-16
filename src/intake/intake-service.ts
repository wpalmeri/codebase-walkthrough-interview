import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { estimateAtIntake } from "../pricing/intake-estimate.js";
import { runEligibilityCheck } from "./eligibility-service.js";
import { writeAudit } from "../audit/audit-service.js";

export interface IntakeOrderInput {
  patientId: string;
  coverageId: string;
  branchId: string;
  serviceType: string;
  orderedBy: string;
  requestedVisits: number;
  startDate: Date;
  diagnosis?: string;
  frequency?: string;
  runEligibility?: boolean;
}

/**
 * Full intake: episode -> order -> authorization request -> VisitSet with a
 * placeholder VisitGroup. Eight sequential writes with no transaction; a
 * failure partway (or a closed browser tab on the review step) leaves empty
 * sets and placeholder groups behind. See abandonIntake below, which "cleans
 * up" by status flag only.
 */
export async function createIntakeOrder(context: RequestContext, input: IntakeOrderInput) {
  const patient = await db.patient.findFirstOrThrow({ where: { id: input.patientId, organizationId: context.organizationId } });

  const eligibility = input.runEligibility === false ? null : await runEligibilityCheck(context, input.coverageId).catch(() => null);

  const episode = await db.careEpisode.create({
    data: { patientId: patient.id, name: `${input.serviceType} episode`, startedAt: input.startDate },
  });
  const order = await db.serviceOrder.create({
    data: {
      episodeId: episode.id,
      serviceType: input.serviceType,
      orderedBy: input.orderedBy,
      orderedAt: new Date(),
      details: { create: { diagnosis: input.diagnosis, frequency: input.frequency ?? "As ordered", durationWeeks: 8 } },
      requests: { create: { requestedUnits: input.requestedVisits, requestedStart: input.startDate } },
    },
  });
  const authorization = await db.authorization.create({
    data: {
      coverageId: input.coverageId,
      authorizationNumber: `PENDING-${Date.now()}`,
      serviceType: input.serviceType,
      maxVisits: input.requestedVisits,
      effectiveFrom: input.startDate,
      effectiveTo: new Date(input.startDate.getTime() + 90 * 86_400_000),
      requestedBy: context.userId,
    },
  });
  const visitSet = await db.visitSet.create({
    data: {
      organizationId: context.organizationId,
      patientId: patient.id,
      orderId: order.id,
      coverageId: input.coverageId,
      authorizationId: authorization.id,
      serviceType: input.serviceType,
      expectedVisitCount: input.requestedVisits,
      startDate: input.startDate,
    },
  });
  const placeholderGroup = await db.visitGroup.create({
    data: { visitSetId: visitSet.id, branchId: input.branchId, scheduledDate: input.startDate, status: "PLACEHOLDER" },
  });
  const estimate = await estimateAtIntake(context.organizationId, input.coverageId, input.serviceType, input.startDate);
  await writeAudit(context.organizationId, context.userId, "intake.completed", "VisitSet", visitSet.id, {
    orderId: order.id,
    serviceType: input.serviceType,
  });

  return { episode, order, authorization, visitSet, placeholderGroup, estimate, eligibility: eligibility?.response ?? null };
}

/** Marks an in-progress intake abandoned. The set, group, order, and auth rows remain. */
export async function abandonIntake(context: RequestContext, visitSetId: string) {
  const set = await db.visitSet.findFirstOrThrow({ where: { id: visitSetId, organizationId: context.organizationId } });
  await db.visitSet.update({ where: { id: set.id }, data: { status: "ABANDONED" } });
  return { abandoned: true, visitSetId: set.id };
}
