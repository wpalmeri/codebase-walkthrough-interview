import assert from "node:assert/strict";
import { prisma } from "../db";
import { DomainInvariantError, PreconditionError } from "../errors";
import {
  applyPayment,
  getPayment,
  listPayments,
  reversePaymentApplication,
  type PaymentMutationAudit,
} from "./paymentController";
import { annualRevenue, revenueByCustomer, revenueByQuarter } from "./reportController";

function audit(requestId: string): PaymentMutationAudit {
  return {
    metadata: {
      principal: {
        kind: "DEVELOPMENT",
        subjectId: "integration:payment-integrity",
        credentialId: "integration-payment-integrity",
      },
      requestId,
    },
  };
}

async function seedLedger(suffix: string, amount: string) {
  const customerId = `payment-integrity-customer-${suffix}`;
  const orderId = `payment-integrity-order-${suffix}`;
  const invoiceId = `payment-integrity-invoice-${suffix}`;
  const paymentId = `payment-integrity-payment-${suffix}`;
  const applicationId = `payment-integrity-application-${suffix}`;
  const numericAmount = Number(amount);
  await prisma.customer.create({
    data: { id: customerId, name: `Customer ${suffix}`, email: `${suffix}@example.com` },
  });
  await prisma.order.create({ data: { id: orderId, customerId, currencyCode: "USD" } });
  await prisma.invoice.create({
    data: {
      id: invoiceId,
      number: `INTEGRITY-${suffix}`,
      customerId,
      orderId,
      status: "PAID",
      dueDate: new Date("2026-11-30T00:00:00.000Z"),
      total: numericAmount,
      totalDecimal: `${amount}.0000`,
      amountPaid: numericAmount,
      amountPaidDecimal: `${amount}.0000`,
      currencyCode: "USD",
      accountingDate: "2026-10-15",
      postedAt: new Date("2026-10-15T00:00:00.000Z"),
    },
  });
  await prisma.payment.create({
    data: {
      id: paymentId,
      customerId,
      amount: numericAmount,
      amountDecimal: `${amount}.0000`,
      currencyCode: "USD",
    },
  });
  await prisma.paymentApplication.create({
    data: {
      id: applicationId,
      paymentId,
      invoiceId,
      amount: numericAmount,
      amountDecimal: `${amount}.0000`,
    },
  });
  return { customerId, invoiceId, paymentId, applicationId };
}

async function main(): Promise<void> {
  try {
    const customerA = await seedLedger("a", "100");
    const customerB = await seedLedger("b", "200");

    assert.deepEqual(
      (await listPayments()).map((payment) => payment.id).toSorted(),
      [customerA.paymentId, customerB.paymentId].toSorted(),
      "operators list the company ledger without artificial partitions"
    );
    assert.equal((await getPayment(customerB.paymentId)).customerId, customerB.customerId);
    assert.deepEqual(await revenueByQuarter({ from: "2026-10-01", to: "2026-12-31" }), [
      { quarter: "2026-Q4", invoiceCount: 2, revenue: 300, revenueDecimal: "300.0000" },
    ]);
    assert.deepEqual(await annualRevenue({ from: "2026-01-01", to: "2026-12-31" }), [
      { year: 2026, invoiceCount: 2, revenue: 300, revenueDecimal: "300.0000" },
    ]);
    assert.deepEqual(await revenueByCustomer({ from: "2026-10-01", to: "2026-12-31" }), [
      { customerId: customerB.customerId, customerName: "Customer b", invoiceCount: 1, revenue: 200, revenueDecimal: "200.0000" },
      { customerId: customerA.customerId, customerName: "Customer a", invoiceCount: 1, revenue: 100, revenueDecimal: "100.0000" },
    ]);

    const applicationsBefore = await prisma.paymentApplication.count();
    await assert.rejects(
      applyPayment(customerA.paymentId, [{ invoiceId: customerB.invoiceId, amount: "1.0000" }], audit("cross-customer-apply")),
      (error) => {
        assert.ok(error instanceof DomainInvariantError);
        assert.equal(error.problem.code, "PAYMENT_ALLOCATION_INVALID");
        return true;
      }
    );
    assert.equal(await prisma.paymentApplication.count(), applicationsBefore);

    await prisma.accountingPeriodControl.create({ data: { id: 1, closedThroughDate: "2026-10-31" } });
    await assert.rejects(
      reversePaymentApplication(
        customerA.paymentId,
        customerA.applicationId,
        { amount: "1.0000", reason: "closed-period integrity", accountingDate: "2026-10-31" },
        audit("closed-period-reversal")
      ),
      (error) => {
        assert.ok(error instanceof PreconditionError);
        assert.equal(error.problem.code, "ACCOUNTING_PERIOD_CLOSED");
        return true;
      }
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
