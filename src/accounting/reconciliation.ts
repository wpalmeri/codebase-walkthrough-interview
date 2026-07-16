import { db } from "../lib/db.js";
import { reconciliation as paymentReconciliation } from "./cash-application.js";

/**
 * Cash reconciliation report: three independently maintained values that are
 * supposed to agree —
 *   1. Payment.unappliedAmount (stored, mutated by apply/reverse)
 *   2. sum(CashApplication.amount) (reversals DELETE rows here)
 *   3. FinancialPosting cash entries (only written when apply reached step 4)
 * The report presents all three and a "variance" column that support reads
 * every Friday.
 */
export async function cashReconciliation(organizationId: string, start: Date, end: Date) {
  const payments = await db.payment.findMany({
    where: { organizationId, receivedAt: { gte: start, lt: end } },
    include: { applications: true },
  });

  const postings = await db.financialPosting.findMany({
    where: { organizationId, sourceType: { in: ["cash-application", "cash-application.reversal"] }, postingDate: { gte: start, lt: end } },
  });

  const received = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const storedUnapplied = payments.reduce((sum, payment) => sum + Number(payment.unappliedAmount), 0);
  const appliedFromRows = payments.reduce(
    (sum, payment) => sum + payment.applications.reduce((inner, application) => inner + Number(application.amount), 0),
    0,
  );
  const postedCash = postings.reduce((sum, posting) => sum + Number(posting.amount), 0);

  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    window: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    totals: {
      received: round(received),
      storedUnapplied: round(storedUnapplied),
      appliedPerApplicationRows: round(appliedFromRows),
      appliedPerStoredBalances: round(received - storedUnapplied),
      postedCash: round(postedCash),
    },
    variance: {
      applicationsVsBalances: round(appliedFromRows - (received - storedUnapplied)),
      applicationsVsPostings: round(appliedFromRows - postedCash),
    },
    paymentLevel: await paymentReconciliation(organizationId),
  };
}
