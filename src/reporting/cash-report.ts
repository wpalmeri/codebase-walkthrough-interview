import { db } from "../lib/db.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Cash reconciliation: payments received in the window, with applied cash
 * derived from CashApplication rows and compared against the stored
 * unapplied balance.
 */
export async function cashReconciliationReport(organizationId: string, start: Date, end: Date) {
  const payments = await db.payment.findMany({
    where: { organizationId, receivedAt: { gte: start, lt: end } },
    include: { applications: { include: { claim: { select: { id: true, claimNumber: true, status: true } } } } },
    orderBy: { receivedAt: "asc" },
  });

  const rows = payments.map((payment) => {
    // Applied cash is the sum of surviving CashApplication rows. Reversals
    // delete the row outright (accounting/cash-application.ts), so a payment
    // that was applied and reversed shows no trace here; the schema's
    // reversedAt column exists but that path never sets it.
    const applied = payment.applications.reduce((sum, application) => sum + Number(application.amount), 0);
    const received = Number(payment.amount);
    const storedUnapplied = Number(payment.unappliedAmount);
    const derivedUnapplied = received - applied;
    return {
      paymentId: payment.id,
      externalId: payment.externalId,
      method: payment.method,
      receivedAt: payment.receivedAt,
      received,
      applied,
      applicationCount: payment.applications.length,
      appliedClaims: payment.applications.map((application) => application.claim.claimNumber ?? application.claim.id),
      storedUnapplied,
      derivedUnapplied: round2(derivedUnapplied),
      // Variance should be zero; Decimal columns are collapsed to floats
      // before the subtraction, so penny-level noise shows up on large files.
      variance: round2(storedUnapplied - derivedUnapplied),
    };
  });

  const totals = {
    received: round2(rows.reduce((sum, row) => sum + row.received, 0)),
    applied: round2(rows.reduce((sum, row) => sum + row.applied, 0)),
    storedUnapplied: round2(rows.reduce((sum, row) => sum + row.storedUnapplied, 0)),
    variance: round2(rows.reduce((sum, row) => sum + row.variance, 0)),
  };

  return {
    window: { start, end },
    rows,
    totals,
    outOfBalanceCount: rows.filter((row) => row.variance !== 0).length,
  };
}
