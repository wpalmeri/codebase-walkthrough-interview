import { ClaimStatus, Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { correctedClaimTotal } from "./correction-pricing.js";
import { submitClaim } from "./claim-service.js";

/**
 * Claim corrections.
 *
 * A corrected claim is a brand new claim whose lines are re-priced at
 * *today's* contracted rates (correction-pricing.ts ignores the original
 * service date). Voiding the original is a separate optional step — when the
 * biller forgets, both the original REJECTED claim and the corrected claim
 * carry open balances, and AR double-counts the encounter.
 */
export async function createCorrectedClaim(context: RequestContext, claimId: string, options?: { voidOriginal?: boolean }) {
  const original = await db.claim.findFirst({
    where: { id: claimId, organizationId: context.organizationId },
    include: { lines: { include: { chargeLine: true } } },
  });
  if (!original) throw new NotFoundError("Claim not found");
  if (original.status !== ClaimStatus.REJECTED) {
    throw new ConflictError(`Only rejected claims can be corrected (claim is ${original.status})`);
  }

  const repriced = await correctedClaimTotal(claimId);
  const perLine = new Prisma.Decimal(repriced.corrected).div(original.lines.length).toDecimalPlaces(2);

  const corrected = await db.claim.create({
    data: {
      organizationId: original.organizationId,
      patientId: original.patientId,
      payerId: original.payerId,
      branchId: original.branchId,
      status: ClaimStatus.READY,
      totalAmount: new Prisma.Decimal(repriced.corrected),
      balanceAmount: new Prisma.Decimal(repriced.corrected),
      serviceStart: original.serviceStart,
      serviceEnd: original.serviceEnd,
      correctedFromId: original.id,
      claimNumber: original.claimNumber ? `${original.claimNumber}-C` : null,
      lines: {
        create: original.lines.map((line) => ({
          chargeLineId: line.chargeLineId,
          serviceCode: line.serviceCode ?? line.chargeLine.serviceCode,
          units: line.units ?? line.chargeLine.units,
          amount: perLine,
        })),
      },
      statusHistory: { create: { toStatus: "READY", changedBy: context.userId, note: `Correction of ${original.id}` } },
    },
    include: { lines: true },
  });

  if (options?.voidOriginal) {
    await db.claim.update({ where: { id: original.id }, data: { status: ClaimStatus.VOIDED, balanceAmount: new Prisma.Decimal(0) } });
    await db.claimStatusHistory.create({ data: { claimId: original.id, fromStatus: original.status, toStatus: "VOIDED", changedBy: context.userId } });
  }

  return { corrected, original: { id: original.id, voided: options?.voidOriginal ?? false }, repriced };
}

export async function resubmitCorrectedClaim(context: RequestContext, correctedClaimId: string) {
  const claim = await db.claim.findFirst({ where: { id: correctedClaimId, organizationId: context.organizationId } });
  if (!claim) throw new NotFoundError("Claim not found");
  if (!claim.correctedFromId) throw new ConflictError("Claim is not a correction");
  return submitClaim(correctedClaimId);
}
