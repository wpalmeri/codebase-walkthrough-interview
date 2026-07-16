import { db } from "../../src/lib/db.js";
import { calculatePeriod, closePeriod, addPeriodAdjustment } from "../../src/accounting/month-close.js";
import { arAging } from "../../src/accounting/ar-service.js";

describe("month close and accounting", () => {
  it("recomputes revenue from live data every time calculatePeriod runs", async () => {
    const first = await calculatePeriod("period_may");
    const second = await calculatePeriod("period_may");
    // Idempotent while inputs are unchanged...
    expect(first.revenue.toNumber()).toBe(second.revenue.toNumber());
    expect(first.sources.length).toBe(second.sources.length);
  });

  it("closing only flips the period status and stores no revenue snapshot", async () => {
    await db.accountingPeriod.update({ where: { id: "period_june" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    const closed = await closePeriod("period_june", "user_admin");
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedBy).toBe("user_admin");
    await db.accountingPeriod.update({ where: { id: "period_june" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
  });

  it("re-derives a closed period's revenue from current rates, so a later rate edit moves it (INC-1101)", async () => {
    await db.accountingPeriod.update({ where: { id: "period_june" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    await closePeriod("period_june", "user_admin");
    const atClose = await calculatePeriod("period_june");

    const rate = await db.payerRate.findUniqueOrThrow({ where: { id: "rate_rn" } });
    await db.payerRate.update({ where: { id: "rate_rn" }, data: { amount: rate.amount.add(15) } });
    const afterEdit = await calculatePeriod("period_june");
    await db.payerRate.update({ where: { id: "rate_rn" }, data: { amount: rate.amount } });

    // Nothing was snapshotted at close, so the closed month now reports a
    // different revenue than it did at close time.
    expect(afterEdit.revenue.toNumber()).not.toBe(atClose.revenue.toNumber());

    await db.accountingPeriod.update({ where: { id: "period_june" }, data: { status: "OPEN", closedAt: null, closedBy: null } });
  });

  it("records explicit period adjustments separately from the close run", async () => {
    const adjustment = await addPeriodAdjustment("period_may", "Test adjustment", 123.45, "user_admin");
    expect(Number(adjustment.amount)).toBe(123.45);
    await db.periodAdjustment.delete({ where: { id: adjustment.id } });
  });

  it("ages accounts receivable from stored claim balances", async () => {
    const aging = await arAging("org_evergreen");
    expect(aging.buckets).toHaveLength(4);
    expect(aging.totalBalance).toBeGreaterThanOrEqual(0);
  });
});
