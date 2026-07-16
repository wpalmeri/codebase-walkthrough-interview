import { db } from "../../src/lib/db.js";
import { calculatePeriod, closePeriod } from "../../src/accounting/month-close.js";
import { displayScheduledPrice } from "../../src/pricing/scheduling-price.js";
import { legacyVisitPrice } from "../../src/pricing/legacy-price-resolver.js";

describe("financial behavior", () => {
  it("resolves different prices in different product paths", async () => {
    const scheduled = await displayScheduledPrice("visit_0_0_0");
    const billing = await legacyVisitPrice("visit_0_0_0");
    expect(Number(scheduled.amount)).toBe(149.5);
    expect(Number(billing.amount)).toBe(122.75);
  });

  it("keeps re-deriving a closed period's revenue from mutable rates", async () => {
    await db.accountingPeriod.update({ where: { id: "period_may" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    await closePeriod("period_may", "user_admin");
    const atClose = await calculatePeriod("period_may");
    const original = await db.payerRate.findUniqueOrThrow({ where: { id: "rate_rn" } });
    await db.payerRate.update({ where: { id: "rate_rn" }, data: { amount: original.amount.add(10) } });
    const recalculated = await calculatePeriod("period_may");
    await db.payerRate.update({ where: { id: "rate_rn" }, data: { amount: original.amount } });
    await db.accountingPeriod.update({ where: { id: "period_may" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    // The period is closed, but its revenue still tracks the live rate table.
    expect(recalculated.revenue.toNumber()).toBeGreaterThan(atClose.revenue.toNumber());
  });
});
