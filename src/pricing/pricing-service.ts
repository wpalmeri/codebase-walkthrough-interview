import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { UnprocessableError } from "../lib/errors.js";
import { credentialMultiplier } from "./modifiers.js";
import { roundPerUnit } from "./rounding.js";

/**
 * PricingService — the intended single pricing boundary.
 *
 * Written during the Q1 "pricing correctness" push. It resolves rates
 * deterministically (contract precedence, then rate priority, then newest
 * effective date), prices against the coverage and service date it is given,
 * and returns a snapshot suitable for persisting.
 *
 * Adoption so far: Lakeside charge creation (behind a customer check) and the
 * pricing debug endpoint. Everything else still queries PayerRate directly —
 * see the callers of prisma.payerRate.* across intake, orders, scheduling,
 * visits, revenue-cycle, accounting, reporting, and ai-employee.
 */

export interface PriceQuery {
  organizationId: string;
  coverageId: string;
  serviceType: string;
  serviceDate: Date;
  locationId?: string | null;
  credential?: string | null;
  units?: number;
}

export interface PriceQuote {
  amount: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  units: number;
  rateId: string;
  contractId: string;
  contractVersion: number;
  credentialMultiplier: number;
  source: "pricing-service";
  resolvedAt: string;
}

export class RateNotFoundError extends UnprocessableError {}

export async function quotePrice(query: PriceQuery): Promise<PriceQuote> {
  const coverage = await db.insuranceCoverage.findUnique({ where: { id: query.coverageId } });
  if (!coverage) throw new UnprocessableError(`Coverage ${query.coverageId} not found`);

  const contracts = await db.payerContract.findMany({
    where: {
      payerId: coverage.payerId,
      organizationId: query.organizationId,
      active: true,
      effectiveFrom: { lte: query.serviceDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: query.serviceDate } }],
    },
    orderBy: [{ precedence: "desc" }, { effectiveFrom: "desc" }],
  });

  for (const contract of contracts) {
    const rate = await db.payerRate.findFirst({
      where: {
        contractId: contract.id,
        serviceType: query.serviceType,
        effectiveFrom: { lte: query.serviceDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: query.serviceDate } }],
        AND: [{ OR: [{ locationId: query.locationId ?? undefined }, { locationId: null }] }],
      },
      orderBy: [{ locationId: { sort: "desc", nulls: "last" } }, { priority: "desc" }, { effectiveFrom: "desc" }, { id: "asc" }],
    });
    if (!rate) continue;

    const multiplier = credentialMultiplier(query.credential);
    const units = query.units ?? 1;
    const unitPrice = rate.amount.times(multiplier).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    return {
      amount: roundPerUnit(unitPrice, units),
      unitPrice,
      units,
      rateId: rate.id,
      contractId: contract.id,
      contractVersion: contract.version,
      credentialMultiplier: multiplier,
      source: "pricing-service",
      resolvedAt: new Date().toISOString(),
    };
  }

  throw new RateNotFoundError(
    `No contracted rate for ${query.serviceType} on ${query.serviceDate.toISOString().slice(0, 10)}`,
    { coverageId: query.coverageId, serviceType: query.serviceType },
  );
}

/** Serializable provenance blob for Charge.pricingSnapshot. */
export function snapshotFromQuote(quote: PriceQuote): Record<string, unknown> {
  return {
    source: quote.source,
    rateId: quote.rateId,
    contractId: quote.contractId,
    contractVersion: quote.contractVersion,
    unitPrice: quote.unitPrice.toString(),
    units: quote.units,
    amount: quote.amount.toString(),
    credentialMultiplier: quote.credentialMultiplier,
    resolvedAt: quote.resolvedAt,
  };
}
