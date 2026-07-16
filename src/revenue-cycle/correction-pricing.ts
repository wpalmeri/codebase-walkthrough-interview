import { db } from "../lib/db.js";

export async function correctedClaimTotal(claimId: string) {
  const claim = await db.claim.findUniqueOrThrow({ include: { lines: { include: { chargeLine: { include: { charge: { include: { visit: { include: { visitGroup: { include: { visitSet: true } } } } } } } } } } }, where: { id: claimId } });
  let total = 0;
  for (const line of claim.lines) {
    const rate = await db.payerRate.findFirst({ where: { serviceType: line.chargeLine.serviceCode, contract: { payerId: claim.payerId, organizationId: claim.organizationId, active: true } } });
    total += Number(rate?.amount ?? line.chargeLine.unitPrice) * Number(line.chargeLine.units);
  }
  return { claimId, previous: Number(claim.totalAmount), corrected: Math.round(total * 100) / 100 };
}
