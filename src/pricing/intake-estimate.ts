import { db } from "../lib/db.js";
import type { PriceResult } from "./rate-types.js";

export async function estimateAtIntake(organizationId: string, coverageId: string, serviceType: string, asOf: Date): Promise<PriceResult> {
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ include: { payer: true }, where: { id: coverageId } });
  const rate = await db.payerRate.findFirstOrThrow({
    where: { serviceType, contract: { organizationId, payerId: coverage.payerId, active: true, effectiveFrom: { lte: new Date() } } },
  });
  return { amount: Number(rate.amount) * 0.2, rateId: rate.id, source: "intake-current-contract" };
}
