import { ClaimStatus, Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { legacyVisitPrice } from "../pricing/legacy-price-resolver.js";
import { submitToClearinghouse } from "./clearinghouse-client.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_CLAIM_SUBMITTED } from "../events/event-names.js";

export async function createClaimForCharges(organizationId: string, patientId: string, payerId: string, chargeIds: string[]) {
  const charges = await db.charge.findMany({ where: { id: { in: chargeIds } }, include: { lines: true } });
  let total = new Prisma.Decimal(0);
  const lines = charges.flatMap((charge) => charge.lines.map((line) => {
    total = total.add(line.amount);
    return { chargeLineId: line.id, amount: line.amount };
  }));
  return db.claim.create({ data: { organizationId, patientId, payerId, status: ClaimStatus.READY, totalAmount: total, balanceAmount: total, lines: { create: lines } }, include: { lines: true } });
}

export async function previewCorrectedClaim(claimId: string) {
  const claim = await db.claim.findUniqueOrThrow({ include: { lines: { include: { chargeLine: { include: { charge: true } } } } }, where: { id: claimId } });
  let repricedTotal = 0;
  for (const line of claim.lines) repricedTotal += Number((await legacyVisitPrice(line.chargeLine.charge.visitId)).amount);
  return { claimId, storedTotal: Number(claim.totalAmount), repricedTotal, difference: repricedTotal - Number(claim.totalAmount) };
}

/**
 * Submits a claim to the clearinghouse.
 *
 * The vendor call happens first; the attempt row and claim update are only
 * written when it returns. A timeout after vendor-side acceptance (INC-1088)
 * therefore records nothing locally — the claim still says READY, and the
 * biller's retry produces a duplicate on the payer side.
 */
export async function submitClaim(claimId: string, simulateTimeout = false) {
  const claim = await db.claim.findUniqueOrThrow({ include: { lines: true }, where: { id: claimId } });

  if (simulateTimeout) {
    // The simulator accepts and *then* the connection dies.
    const externalId = `CH-${claim.id}-${Date.now()}`;
    throw new Error(`Clearinghouse timeout after accepting ${externalId}`);
  }

  const payer = await db.payer.findUniqueOrThrow({ where: { id: claim.payerId } });
  const ack = await submitToClearinghouse({
    claimId: claim.id,
    payerCode: payer.code,
    totalAmount: claim.totalAmount.toString(),
    lines: claim.lines.map((line) => ({
      procedureCode: line.serviceCode ?? "UNKNOWN",
      units: line.units?.toString() ?? "1",
      amount: line.amount.toString(),
    })),
  });

  await db.claimSubmissionAttempt.create({
    data: { claimId, status: "ACCEPTED", requestId: ack.requestId, response: { externalId: ack.externalId } },
  });
  const updated = await db.claim.update({
    where: { id: claimId },
    data: { status: ClaimStatus.SUBMITTED, externalId: ack.externalId, submittedAt: new Date() },
  });
  await db.claimStatusHistory.create({ data: { claimId, fromStatus: claim.status, toStatus: "SUBMITTED", changedBy: "biller" } });
  await emitDomainEvent({
    organizationId: claim.organizationId,
    eventName: EVENT_CLAIM_SUBMITTED,
    aggregateType: "Claim",
    aggregateId: claimId,
    payload: { claimId, externalId: ack.externalId, totalAmount: claim.totalAmount.toString() },
  });
  return updated;
}

export interface ClaimQueueFilters {
  status?: ClaimStatus;
  payerId?: string;
  patientId?: string;
  minBalance?: number;
}

export async function claimQueue(organizationId: string, filters: ClaimQueueFilters = {}, page = 1, pageSize = 25) {
  const where = {
    organizationId,
    status: filters.status,
    payerId: filters.payerId,
    patientId: filters.patientId,
    balanceAmount: filters.minBalance ? { gte: new Prisma.Decimal(filters.minBalance) } : undefined,
  };
  const total = await db.claim.count({ where });
  const claims = await db.claim.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: {
      lines: { include: { chargeLine: { include: { charge: { include: { visit: { include: { patient: true } } } } } } } },
      rejections: { where: { resolvedAt: null } },
      attempts: { orderBy: { attemptedAt: "desc" }, take: 1 },
    },
  });
  return {
    page,
    pageSize,
    total,
    data: claims.map((claim) => ({
      id: claim.id,
      claimNumber: claim.claimNumber,
      externalId: claim.externalId,
      status: claim.status,
      totalAmount: Number(claim.totalAmount),
      balanceAmount: Number(claim.balanceAmount),
      submittedAt: claim.submittedAt,
      patientName: claim.lines[0]
        ? `${claim.lines[0].chargeLine.charge.visit.patient.lastName}, ${claim.lines[0].chargeLine.charge.visit.patient.firstName}`
        : claim.patientId,
      openRejections: claim.rejections.map((rejection) => ({ code: rejection.code, message: rejection.message })),
      lastAttemptAt: claim.attempts[0]?.attemptedAt ?? null,
      lineCount: claim.lines.length,
    })),
  };
}
