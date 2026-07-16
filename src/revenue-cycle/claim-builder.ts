import { ClaimStatus, Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { UnprocessableError } from "../lib/errors.js";
import { claimLinePrice } from "./claim-line-pricing.js";
import { billingReadiness } from "./billing-readiness.js";
import { roundFinalTotal } from "../pricing/rounding.js";

/**
 * Generates claims from posted charges.
 *
 * Lines are re-priced at claim time through claimLinePrice (current contract
 * rates), so a claim's total can differ from the sum of its charges when
 * rates changed between service and billing. Totals round once at the end
 * (banker's rounding) while charges rounded per unit — the two disagree by a
 * cent on odd unit counts. branchId is taken from the first visit's group;
 * multi-branch claims keep whichever came first.
 */
export async function buildClaimsForOrganization(context: RequestContext, options?: { limit?: number }) {
  const charges = await db.charge.findMany({
    where: {
      status: "POSTED",
      lines: { some: { claimLines: { none: {} } } },
      visit: { visitGroup: { visitSet: { organizationId: context.organizationId } } },
    },
    include: {
      lines: { include: { claimLines: true } },
      visit: { include: { patient: true, visitGroup: { include: { visitSet: true } } } },
    },
    take: options?.limit ?? 50,
  });

  const groups = new Map<string, typeof charges>();
  for (const charge of charges) {
    const readiness = await billingReadiness(charge.visitId).catch(() => null);
    if (!readiness?.ready) continue;
    const coverage = charge.coverageId
      ? await db.insuranceCoverage.findUnique({ where: { id: charge.coverageId } })
      : charge.visit.patient.currentCoverageId
        ? await db.insuranceCoverage.findUnique({ where: { id: charge.visit.patient.currentCoverageId } })
        : null;
    if (!coverage) continue;
    const key = `${charge.visit.patientId}:${coverage.payerId}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(charge);
    groups.set(key, bucket);
  }

  const claims: Array<Prisma.ClaimGetPayload<{ include: { lines: true } }>> = [];
  for (const [key, bucket] of groups) {
    const [patientId, payerId] = key.split(":") as [string, string];
    const lineInputs: Array<{ chargeLineId: string; serviceCode: string; units: Prisma.Decimal; amount: Prisma.Decimal }> = [];
    let unitTotal = new Prisma.Decimal(0);

    for (const charge of bucket) {
      for (const line of charge.lines) {
        if (line.claimLines.length > 0) continue;
        const priced = await claimLinePrice(line.id);
        const amount = roundFinalTotal(new Prisma.Decimal(priced.unitPrice.toFixed(4)), priced.units);
        lineInputs.push({ chargeLineId: line.id, serviceCode: line.serviceCode, units: line.units, amount });
        unitTotal = unitTotal.add(amount);
      }
    }
    if (lineInputs.length === 0) continue;

    const serviceDates = bucket.map((charge) => charge.visit.scheduledStart.getTime());
    const claim = await db.claim.create({
      data: {
        organizationId: context.organizationId,
        patientId,
        payerId,
        branchId: bucket[0]!.visit.visitGroup.branchId,
        status: ClaimStatus.READY,
        totalAmount: unitTotal,
        balanceAmount: unitTotal,
        serviceStart: new Date(Math.min(...serviceDates)),
        serviceEnd: new Date(Math.max(...serviceDates)),
        claimNumber: `CLM-${Date.now()}-${claims.length}`,
        lines: { create: lineInputs.map((line) => ({ chargeLineId: line.chargeLineId, serviceCode: line.serviceCode, units: line.units, amount: line.amount })) },
        statusHistory: { create: { toStatus: "READY", changedBy: context.userId } },
      },
      include: { lines: true },
    });
    claims.push(claim);
  }

  if (charges.length === 0 && claims.length === 0) {
    return { created: 0, claims: [], message: "No unbilled posted charges found" };
  }
  if (claims.length === 0) {
    throw new UnprocessableError("Charges exist but none are billing-ready", { candidates: charges.length });
  }
  return { created: claims.length, claims };
}
