import { db } from "../../src/lib/db.js";
import { importPayment, applyCash, reverseCashApplication, reconciliation, unappliedCashSummary } from "../../src/accounting/cash-application.js";

describe("cash application", () => {
  it("deletes the application row on reversal, leaving no durable trace in the rows", async () => {
    const claim = await db.claim.create({ data: {
      id: "test_rev_claim", organizationId: "org_northstar", patientId: "patient_002", payerId: "payer_acme",
      status: "ACCEPTED", totalAmount: 200, balanceAmount: 200,
    } });
    const payment = await importPayment("org_northstar", `TEST-REV-${claim.id}`, 200, new Date());
    const application = await applyCash(payment.id, claim.id, 200);

    const afterApply = await db.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(afterApply.status).toBe("PAID");

    await reverseCashApplication(application.id);

    // The row is gone entirely; reconciliation that recomputes "applied" from
    // surviving rows can no longer see this reversal happened.
    const remaining = await db.cashApplication.count({ where: { id: application.id } });
    expect(remaining).toBe(0);
    const afterReverse = await db.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(Number(afterReverse.balanceAmount)).toBe(200);

    await db.payment.delete({ where: { id: payment.id } });
    await db.claim.delete({ where: { id: claim.id } });
  });

  it("reports unapplied cash sitting in the enterprise queue", async () => {
    const summary = await unappliedCashSummary("org_evergreen");
    expect(summary.totalUnapplied).toBeGreaterThan(0);
    expect(summary.payments.length).toBeGreaterThan(0);
  });

  it("reconciliation compares stored balances against surviving application rows", async () => {
    const rows = await reconciliation("org_northstar");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((row) => typeof row.matches === "boolean")).toBe(true);
  });
});
