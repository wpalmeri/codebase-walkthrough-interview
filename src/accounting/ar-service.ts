import { db } from "../lib/db.js";

/**
 * Accounts receivable, aged from stored claim balances. The balance column
 * is maintained by cash application in separate writes (and reversals delete
 * application rows), so AR here can disagree with payments minus
 * applications. Aging is bucketed from submittedAt, but claims corrected
 * without voiding the original appear in both generations.
 */

const BUCKETS = [
  { key: "current", from: 0, to: 30 },
  { key: "31-60", from: 31, to: 60 },
  { key: "61-90", from: 61, to: 90 },
  { key: "90+", from: 91, to: 100_000 },
] as const;

export async function arAging(organizationId: string, asOf: Date = new Date()) {
  const claims = await db.claim.findMany({
    where: { organizationId, status: { notIn: ["PAID", "VOIDED", "DRAFT"] }, balanceAmount: { gt: 0 } },
  });

  const buckets = new Map<string, { count: number; balance: number }>(
    BUCKETS.map((bucket) => [bucket.key, { count: 0, balance: 0 }]),
  );
  let totalBalance = 0;
  for (const claim of claims) {
    const reference = claim.submittedAt ?? claim.createdAt;
    const ageDays = Math.floor((asOf.getTime() - reference.getTime()) / 86_400_000);
    const bucket = BUCKETS.find((candidate) => ageDays >= candidate.from && ageDays <= candidate.to) ?? BUCKETS[3];
    const entry = buckets.get(bucket.key)!;
    entry.count += 1;
    entry.balance += Number(claim.balanceAmount);
    totalBalance += Number(claim.balanceAmount);
  }

  return {
    asOf: asOf.toISOString().slice(0, 10),
    totalBalance: Math.round(totalBalance * 100) / 100,
    openClaims: claims.length,
    buckets: BUCKETS.map((bucket) => ({
      bucket: bucket.key,
      count: buckets.get(bucket.key)!.count,
      balance: Math.round(buckets.get(bucket.key)!.balance * 100) / 100,
    })),
  };
}
