import { db } from "../../src/lib/db.js";
import { calculatePeriod, closePeriod } from "../../src/accounting/month-close.js";

/**
 * INC-1101 — a closed month's reported revenue changes after a later rate
 * correction, because the close recomputes from mutable operational data and
 * stores no authoritative source facts. Reproduction is real; kept skipped
 * because it fails on purpose.
 */
describe.skip("incident INC-1101: closed month changed", () => {
  it("reproduces the exact close after a rate correction", async () => {
    await db.accountingPeriod.update({ where: { id: "period_may" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    await closePeriod("period_may", "user_admin");
    const reportedAtClose = await calculatePeriod("period_may");

    const rate = await db.payerRate.findUniqueOrThrow({ where: { id: "rate_rn" } });
    await db.payerRate.update({ where: { id: "rate_rn" }, data: { amount: rate.amount.add(25) } });
    const recomputed = await calculatePeriod("period_may");
    await db.payerRate.update({ where: { id: "rate_rn" }, data: { amount: rate.amount } });

    // Safe behavior (does not hold today): a closed month reproduces its
    // reported revenue regardless of later rate edits.
    expect(recomputed.revenue.toNumber()).toBe(reportedAtClose.revenue.toNumber());
  });
});
