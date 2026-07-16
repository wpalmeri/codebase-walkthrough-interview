import { db } from "../lib/db.js";
import { usesWeeklyAgingBuckets } from "../config/customer-overrides.js";

const DAY_MS = 86_400_000;

function standardBucket(age: number): string {
  if (age <= 30) return "current";
  if (age <= 60) return "days31to60";
  if (age <= 90) return "days61to90";
  return "over90";
}

function weeklyBucket(age: number): string {
  if (age <= 7) return "week1";
  if (age <= 14) return "week2";
  if (age <= 21) return "week3";
  if (age <= 28) return "week4";
  return "older";
}

/**
 * Open claim balances by age. Financial data, but the function takes a bare
 * organizationId — scoping stops at the org.
 */
export async function claimAging(organizationId: string, asOf: Date) {
  // Slug lookup because Evergreen's controller was promised weekly buckets
  // (customer-overrides.ts); everyone else gets 30/60/90.
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const weekly = usesWeeklyAgingBuckets(organization.slug);

  // Corrected claims are created with correctedFromId, but nothing voids the
  // original at correction time; until someone does, both the original and
  // the corrected claim carry a balance and both age in these buckets.
  const claims = await db.claim.findMany({
    where: { organizationId, status: { notIn: ["PAID", "VOIDED"] } },
    orderBy: { createdAt: "asc" },
  });

  const buckets: Record<string, number> = weekly
    ? { week1: 0, week2: 0, week3: 0, week4: 0, older: 0 }
    : { current: 0, days31to60: 0, days61to90: 0, over90: 0 };

  const rows = claims.map((claim) => {
    // Submitted claims age from submission; drafts age from creation, so a
    // claim's age resets the day it finally goes out the door.
    const agedFrom = claim.submittedAt ?? claim.createdAt;
    const age = Math.max(0, Math.floor((asOf.getTime() - agedFrom.getTime()) / DAY_MS));
    const balance = Number(claim.balanceAmount);
    const bucket = weekly ? weeklyBucket(age) : standardBucket(age);
    buckets[bucket] = (buckets[bucket] ?? 0) + balance;
    return {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      patientId: claim.patientId,
      status: claim.status,
      correctedFromId: claim.correctedFromId,
      agedFrom,
      age,
      balance,
      bucket,
    };
  });

  return { asOf, bucketing: weekly ? "weekly" : "standard", buckets, rows };
}
