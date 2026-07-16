import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";

/**
 * FinancialPosting — the beginnings of an immutable ledger, added during the
 * last close-reproducibility incident review. Only cash application (partial)
 * and manual period adjustments write postings today. Visit revenue, charges,
 * claims, and reversals do not, so the posting table cannot reconstruct a
 * period on its own.
 */

export const ACCOUNTS = {
  REVENUE: "4000-service-revenue",
  ACCOUNTS_RECEIVABLE: "1200-accounts-receivable",
  CASH: "1000-cash",
  ADJUSTMENTS: "4900-adjustments",
} as const;

export interface PostingInput {
  organizationId: string;
  sourceType: string;
  sourceId: string;
  postingDate: Date;
  amount: Prisma.Decimal | number | string;
  account: string;
  metadata?: Record<string, unknown>;
}

export async function writePosting(input: PostingInput) {
  return db.financialPosting.create({
    data: {
      organizationId: input.organizationId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      postingDate: input.postingDate,
      amount: new Prisma.Decimal(input.amount.toString()),
      account: input.account,
      metadata: asJson(input.metadata ?? {}),
    },
  });
}

/** Reversal creates an offsetting posting and links the pair. */
export async function reversePosting(postingId: string, reason: string) {
  const original = await db.financialPosting.findUniqueOrThrow({ where: { id: postingId } });
  const reversal = await db.financialPosting.create({
    data: {
      organizationId: original.organizationId,
      sourceType: `${original.sourceType}.reversal`,
      sourceId: original.sourceId,
      postingDate: new Date(),
      amount: original.amount.negated(),
      account: original.account,
      metadata: asJson({ reversedPostingId: postingId, reason }),
    },
  });
  await db.financialPosting.update({ where: { id: postingId }, data: { reversedById: reversal.id } });
  return reversal;
}

export async function postingsForPeriod(organizationId: string, start: Date, end: Date) {
  return db.financialPosting.findMany({
    where: { organizationId, postingDate: { gte: start, lt: end } },
    orderBy: { postingDate: "asc" },
  });
}
