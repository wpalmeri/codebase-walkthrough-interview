import { ClaimStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_CLAIM_REJECTED } from "../events/event-names.js";

/** Rejection payloads arrive from the clearinghouse simulator's callback. */
export async function ingestRejection(claimExternalId: string, code: string, message: string, category?: string) {
  const claim = await db.claim.findFirst({ where: { externalId: claimExternalId } });
  if (!claim) throw new NotFoundError(`No claim with external id ${claimExternalId}`);
  const rejection = await db.claimRejection.create({
    data: { claimId: claim.id, code, message, category },
  });
  await db.claim.update({ where: { id: claim.id }, data: { status: ClaimStatus.REJECTED } });
  await db.claimStatusHistory.create({ data: { claimId: claim.id, fromStatus: claim.status, toStatus: "REJECTED", note: `${code}: ${message}` } });
  await emitDomainEvent({
    organizationId: claim.organizationId,
    eventName: EVENT_CLAIM_REJECTED,
    aggregateType: "Claim",
    aggregateId: claim.id,
    payload: { claimId: claim.id, code, message },
  });
  return rejection;
}

export async function rejectionWorklist(context: RequestContext) {
  const rejections = await db.claimRejection.findMany({
    where: { resolvedAt: null, claim: { organizationId: context.organizationId } },
    include: { claim: { include: { lines: true } } },
    orderBy: { receivedAt: "asc" },
  });
  const rows = [];
  for (const rejection of rejections) {
    const patient = await db.patient.findUnique({ where: { id: rejection.claim.patientId } });
    rows.push({
      rejectionId: rejection.id,
      claimId: rejection.claimId,
      code: rejection.code,
      message: rejection.message,
      category: rejection.category,
      receivedAt: rejection.receivedAt,
      claimTotal: Number(rejection.claim.totalAmount),
      patientName: patient ? `${patient.lastName}, ${patient.firstName}` : rejection.claim.patientId,
      ageDays: Math.floor((Date.now() - rejection.receivedAt.getTime()) / 86_400_000),
    });
  }
  return rows;
}

export async function resolveRejection(context: RequestContext, rejectionId: string, resolution: string) {
  const rejection = await db.claimRejection.findUnique({ where: { id: rejectionId }, include: { claim: true } });
  if (!rejection || rejection.claim.organizationId !== context.organizationId) throw new NotFoundError("Rejection not found");
  return db.claimRejection.update({
    where: { id: rejectionId },
    data: { resolvedAt: new Date(), resolution },
  });
}
