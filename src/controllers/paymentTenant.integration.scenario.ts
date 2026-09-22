import assert from "node:assert/strict";
import { prisma } from "../db";
import { NotFoundError, PreconditionError } from "../errors";
import {
  applyPayment,
  getPayment,
  listPayments,
  reversePaymentApplication,
} from "./paymentController";
import { annualRevenue, revenueByCustomer, revenueByQuarter } from "./reportController";

const tenantA = "payment-scope-tenant-a";
const tenantB = "payment-scope-tenant-b";

async function seedTenantLedger(input: {
  tenantId: string;
  suffix: string;
  amount: string;
}): Promise<{ paymentId: string; invoiceId: string; applicationId: string }> {
  const customerId = `payment-scope-customer-${input.suffix}`;
  const orderId = `payment-scope-order-${input.suffix}`;
  const invoiceId = `payment-scope-invoice-${input.suffix}`;
  const paymentId = `payment-scope-payment-${input.suffix}`;
  const applicationId = `payment-scope-application-${input.suffix}`;
  const amount = Number(input.amount);

  await prisma.customer.create({
    data: {
      id: customerId,
      tenantId: input.tenantId,
      name: `Scoped customer ${input.suffix}`,
      email: `scoped-${input.suffix}@example.com`,
    },
  });
  await prisma.order.create({
    data: { id: orderId, tenantId: input.tenantId, customerId, currencyCode: "USD" },
  });
  await prisma.invoice.create({
    data: {
      id: invoiceId,
      tenantId: input.tenantId,
      number: `SCOPE-${input.suffix}`,
      customerId,
      orderId,
      status: "PAID",
      dueDate: new Date("2026-11-30T00:00:00.000Z"),
      total: amount,
      totalDecimal: `${input.amount}.0000`,
      amountPaid: amount,
      amountPaidDecimal: `${input.amount}.0000`,
      currencyCode: "USD",
      accountingDate: "2026-10-15",
      postedAt: new Date("2026-10-15T00:00:00.000Z"),
    },
  });
  await prisma.payment.create({
    data: {
      id: paymentId,
      tenantId: input.tenantId,
      customerId,
      amount,
      amountDecimal: `${input.amount}.0000`,
      currencyCode: "USD",
    },
  });
  await prisma.paymentApplication.create({
    data: {
      id: applicationId,
      paymentId,
      invoiceId,
      amount,
      amountDecimal: `${input.amount}.0000`,
    },
  });
  return { paymentId, invoiceId, applicationId };
}

async function main(): Promise<void> {
  try {
    await prisma.tenant.createMany({
      data: [
        { id: tenantA, slug: tenantA, name: "Payment scope tenant A" },
        { id: tenantB, slug: tenantB, name: "Payment scope tenant B" },
      ],
    });
    const a = await seedTenantLedger({ tenantId: tenantA, suffix: "a", amount: "100" });
    const b = await seedTenantLedger({ tenantId: tenantB, suffix: "b", amount: "200" });

    const [paymentsA, paymentsB] = await Promise.all([
      listPayments(tenantA),
      listPayments(tenantB),
    ]);
    assert.deepEqual(paymentsA.map(({ id }) => id), [a.paymentId]);
    assert.deepEqual(paymentsB.map(({ id }) => id), [b.paymentId]);
    await assert.rejects(getPayment(tenantA, b.paymentId), (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.problem.code, "PAYMENT_NOT_FOUND");
      return true;
    });

    assert.deepEqual(await revenueByQuarter(tenantA, { from: "2026-10-01", to: "2026-12-31" }), [
      { quarter: "2026-Q4", invoiceCount: 1, revenue: 100, revenueDecimal: "100.0000" },
    ]);
    assert.deepEqual(await revenueByCustomer(tenantB, { from: "2026-10-01", to: "2026-12-31" }), [
      {
        customerId: "payment-scope-customer-b",
        customerName: "Scoped customer b",
        invoiceCount: 1,
        revenue: 200,
        revenueDecimal: "200.0000",
      },
    ]);
    assert.deepEqual(await annualRevenue(tenantA, { from: "2026-01-01", to: "2026-12-31" }), [
      { year: 2026, invoiceCount: 1, revenue: 100, revenueDecimal: "100.0000" },
    ]);

    const beforeCrossApply = {
      applications: await prisma.paymentApplication.count(),
      invoiceB: await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoiceId } }),
      reversals: await prisma.paymentApplicationReversal.count(),
    };
    await assert.rejects(
      applyPayment(tenantA, a.paymentId, [{ invoiceId: b.invoiceId, amount: "1.0000" }]),
      (error) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.problem.code, "PAYMENT_INVOICE_NOT_FOUND");
        return true;
      }
    );
    await assert.rejects(
      reversePaymentApplication(tenantA, a.paymentId, b.applicationId, {
        amount: "1.0000",
        reason: "cross-tenant denial",
        accountingDate: "2026-10-31",
      }),
      (error) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.problem.code, "PAYMENT_APPLICATION_NOT_FOUND");
        return true;
      }
    );
    assert.equal(await prisma.paymentApplication.count(), beforeCrossApply.applications);
    assert.equal(await prisma.paymentApplicationReversal.count(), beforeCrossApply.reversals);
    const afterCrossApplyInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoiceId } });
    assert.equal(afterCrossApplyInvoice.amountPaidDecimal?.toFixed(4), beforeCrossApply.invoiceB.amountPaidDecimal?.toFixed(4));
    assert.equal(afterCrossApplyInvoice.status, beforeCrossApply.invoiceB.status);

    await prisma.tenantAccountingPeriodControl.create({
      data: { id: "payment-scope-close-a", tenantId: tenantA, closedThroughDate: "2026-10-31" },
    });
    await assert.rejects(
      reversePaymentApplication(tenantA, a.paymentId, a.applicationId, {
        amount: "1.0000",
        reason: "tenant A closed period",
        accountingDate: "2026-10-31",
      }),
      (error) => {
        assert.ok(error instanceof PreconditionError);
        assert.equal(error.problem.code, "ACCOUNTING_PERIOD_CLOSED");
        return true;
      }
    );
    const bReversal = await reversePaymentApplication(tenantB, b.paymentId, b.applicationId, {
      amount: "1.0000",
      reason: "tenant B remains open",
      accountingDate: "2026-10-31",
    });
    assert.equal(bReversal.amountDecimal, "1.0000");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } })).amountPaidDecimal?.toFixed(4), "100.0000");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoiceId } })).amountPaidDecimal?.toFixed(4), "199.0000");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
