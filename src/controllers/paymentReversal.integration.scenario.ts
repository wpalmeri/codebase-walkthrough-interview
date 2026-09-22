import assert from "node:assert/strict";
import { prisma } from "../db";
import {
  getPayment,
  reversePaymentApplication,
} from "./paymentController";
import { NotFoundError, PreconditionError } from "../errors";

async function seedPaidApplication(input: {
  suffix: string;
  delivered?: boolean;
}): Promise<{ paymentId: string; applicationId: string; invoiceId: string }> {
  const customerId = `reversal-customer-${input.suffix}`;
  const orderId = `reversal-order-${input.suffix}`;
  const invoiceId = `reversal-invoice-${input.suffix}`;
  const paymentId = `reversal-payment-${input.suffix}`;
  const applicationId = `reversal-application-${input.suffix}`;
  await prisma.customer.create({
    data: {
      id: customerId,
      name: `Reversal Customer ${input.suffix}`,
      email: `${input.suffix}@example.com`,
    },
  });
  await prisma.order.create({
    data: { id: orderId, customerId, currencyCode: "USD" },
  });
  await prisma.invoice.create({
    data: {
      id: invoiceId,
      number: `REV-${input.suffix}`,
      customerId,
      orderId,
      status: "PAID",
      dueDate: new Date("2026-10-31T00:00:00.000Z"),
      total: 100,
      totalDecimal: "100.0000",
      amountPaid: 100,
      amountPaidDecimal: "100.0000",
      currencyCode: "USD",
      accountingDate: "2026-09-22",
      postedAt: new Date("2026-09-22T00:00:00.000Z"),
    },
  });
  if (input.delivered) {
    await prisma.transmission.create({
      data: {
        invoiceId,
        method: "EMAIL",
        status: "SENT",
        detail: "delivered",
      },
    });
  }
  await prisma.payment.create({
    data: {
      id: paymentId,
      customerId,
      amount: 100,
      amountDecimal: "100.0000",
      currencyCode: "USD",
    },
  });
  await prisma.paymentApplication.create({
    data: {
      id: applicationId,
      paymentId,
      invoiceId,
      amount: 100,
      amountDecimal: "100.0000",
    },
  });
  return { paymentId, applicationId, invoiceId };
}

async function main(): Promise<void> {
  try {
    const migrations = await prisma.$queryRaw<{ name: string }[]>`
      SELECT migration_name AS name
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
    `;
    assert.equal(
      migrations.some(
        ({ name }) => name === "20260922080000_payment_application_reversals"
      ),
      true
    );

    const undelivered = await seedPaidApplication({ suffix: "undelivered" });
    const partial = await reversePaymentApplication(
      undelivered.paymentId,
      undelivered.applicationId,
      {
        amount: "25.0000",
        reason: "  Duplicate application  ",
        accountingDate: "2026-10-01",
      }
    );
    assert.equal(partial.amountDecimal, "25.0000");
    assert.equal(partial.reason, "Duplicate application");
    assert.equal(partial.actor, "system:meridian-api");
    let invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: undelivered.invoiceId },
    });
    assert.equal(invoice.amountPaidDecimal?.toFixed(4), "75.0000");
    assert.equal(invoice.status, "POSTED");
    let payment = await getPayment(undelivered.paymentId);
    assert.equal(payment.appliedDecimal, "75.0000");
    assert.equal(payment.unappliedDecimal, "25.0000");
    assert.equal(payment.applications[0]?.netAmountDecimal, "75.0000");

    const full = await reversePaymentApplication(
      undelivered.paymentId,
      undelivered.applicationId,
      {
        amount: "75.0000",
        reason: "Remove remaining application",
        accountingDate: "2026-10-02",
      }
    );
    assert.equal(full.amountDecimal, "75.0000");
    invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: undelivered.invoiceId },
    });
    assert.equal(invoice.amountPaidDecimal?.toFixed(4), "0.0000");
    assert.equal(invoice.status, "POSTED");
    payment = await getPayment(undelivered.paymentId);
    assert.equal(payment.appliedDecimal, "0.0000");
    assert.equal(payment.unappliedDecimal, "100.0000");

    await assert.rejects(
      prisma.paymentApplicationReversal.update({
        where: { id: partial.id },
        data: { reason: "rewrite history" },
      })
    );
    await assert.rejects(
      prisma.paymentApplicationReversal.delete({ where: { id: partial.id } })
    );
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "PaymentApplicationReversal"
          ("id", "paymentApplicationId", "amountDecimal", "reason", "accountingDate", "actor")
        VALUES
          ('over-reversal', ${undelivered.applicationId}, 0.0001, 'over', '2026-10-03', 'system:meridian-api')
      `,
      /exceeds original application/u
    );
    await assert.rejects(
      prisma.$executeRaw`
        UPDATE "Invoice"
        SET "amountPaid" = 1, "amountPaidDecimal" = 1
        WHERE "id" = ${undelivered.invoiceId}
      `,
      /status lacks matching delivery evidence/u
    );

    const delivered = await seedPaidApplication({
      suffix: "delivered",
      delivered: true,
    });
    await reversePaymentApplication(delivered.paymentId, delivered.applicationId, {
      amount: "25.0000",
      reason: "Delivered invoice correction",
      accountingDate: "2026-10-04",
    });
    assert.equal(
      (
        await prisma.invoice.findUniqueOrThrow({
          where: { id: delivered.invoiceId },
        })
      ).status,
      "SENT"
    );

    await prisma.accountingPeriodControl.create({
      data: { id: 1, closedThroughDate: "2026-10-31" },
    });
    await assert.rejects(
      reversePaymentApplication(delivered.paymentId, delivered.applicationId, {
        amount: "1.0000",
        reason: "Closed-period correction",
        accountingDate: "2026-10-31",
      }),
      (error) => {
        assert.ok(error instanceof PreconditionError);
        assert.equal(error.problem.code, "ACCOUNTING_PERIOD_CLOSED");
        return true;
      }
    );
    await assert.rejects(
      reversePaymentApplication(
        undelivered.paymentId,
        delivered.applicationId,
        {
          amount: "1.0000",
          reason: "Wrong target",
          accountingDate: "2026-11-01",
        }
      ),
      (error) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.problem.code, "PAYMENT_APPLICATION_NOT_FOUND");
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
