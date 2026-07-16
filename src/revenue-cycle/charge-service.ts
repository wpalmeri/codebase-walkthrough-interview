import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { ConflictError } from "../lib/errors.js";
import { legacyVisitPrice } from "../pricing/legacy-price-resolver.js";
import { quotePrice, snapshotFromQuote } from "../pricing/pricing-service.js";
import { usesPricingServiceForCharges } from "../config/customer-overrides.js";
import { billingReadiness } from "./billing-readiness.js";
import { roundPerUnit } from "../pricing/rounding.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_CHARGE_POSTED } from "../events/event-names.js";

/**
 * Charge creation. Two pricing paths:
 *  - Lakeside (pilot): the new PricingService, with a full snapshot.
 *  - Everyone else: legacyVisitPrice — current rates, coverage fallback
 *    chain, $100 default — and a snapshot only when the caller asks to post.
 */
export async function createCharge(visitId: string) {
  const readiness = await billingReadiness(visitId);
  if (!readiness.ready) throw new ConflictError(`Visit is not ready: ${readiness.reasons.join(", ")}`);

  const visit = await db.visit.findUniqueOrThrow({
    include: { patient: true, visitGroup: { include: { visitSet: { include: { organization: true } } } } },
    where: { id: visitId },
  });

  if (usesPricingServiceForCharges(visit.visitGroup.visitSet.organization.slug)) {
    const clinician = visit.clinicianId
      ? await db.clinicianProfile.findUnique({ where: { userId: visit.clinicianId } })
      : null;
    const quote = await quotePrice({
      organizationId: visit.visitGroup.visitSet.organizationId,
      coverageId: visit.coverageId ?? visit.visitGroup.visitSet.coverageId ?? visit.patient.currentCoverageId!,
      serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
      serviceDate: visit.actualStart ?? visit.scheduledStart,
      locationId: visit.locationId,
      credential: clinician?.credential,
    });
    return db.charge.create({
      data: {
        visitId,
        coverageId: visit.coverageId ?? visit.visitGroup.visitSet.coverageId,
        totalAmount: quote.amount,
        status: "READY",
        pricingSnapshot: snapshotFromQuote(quote) as Prisma.InputJsonValue,
        lines: {
          create: {
            serviceCode: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
            units: quote.units,
            unitPrice: quote.unitPrice,
            amount: quote.amount,
          },
        },
      },
      include: { lines: true },
    });
  }

  const price = await legacyVisitPrice(visitId);
  const units = price.units ?? 1;
  const unitPrice = new Prisma.Decimal(price.amount.toString()).div(units);
  return db.charge.create({
    data: {
      visitId,
      coverageId: visit.coverageId ?? visit.visitGroup.visitSet.coverageId,
      totalAmount: roundPerUnit(unitPrice, units),
      status: "READY",
      lines: {
        create: {
          serviceCode: visit.visitGroup.visitSet.serviceType,
          units,
          unitPrice,
          amount: price.amount.toString(),
        },
      },
    },
    include: { lines: true },
  });
}

export async function createPostedChargeWithSnapshot(visitId: string) {
  const price = await legacyVisitPrice(visitId);
  const charge = await createCharge(visitId);
  const posted = await db.charge.update({
    where: { id: charge.id },
    data: {
      status: "POSTED",
      postedAt: new Date(),
      pricingSnapshot: charge.pricingSnapshot ?? {
        rateId: price.rateId,
        amount: price.amount,
        units: price.units,
        source: price.source,
      },
    },
    include: { lines: true, visit: { include: { visitGroup: { include: { visitSet: true } } } } },
  });
  await emitDomainEvent({
    organizationId: posted.visit.visitGroup.visitSet.organizationId,
    eventName: EVENT_CHARGE_POSTED,
    aggregateType: "Charge",
    aggregateId: posted.id,
    payload: { chargeId: posted.id, visitId, amount: posted.totalAmount?.toString() ?? null },
  });
  return posted;
}

export async function postCharge(chargeId: string) {
  const charge = await db.charge.findUniqueOrThrow({ where: { id: chargeId } });
  if (charge.status === "POSTED") throw new ConflictError("Charge already posted");
  return db.charge.update({ where: { id: chargeId }, data: { status: "POSTED", postedAt: new Date() } });
}
