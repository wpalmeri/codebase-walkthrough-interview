import assert from "node:assert/strict";
import { prisma } from "../db";
import {
  INVOICE_DECIMAL_BACKFILL_JOB,
  runInvoiceDecimalBackfill,
} from "./invoiceDecimalBackfill";

async function main(): Promise<void> {
  const customer = await prisma.customer.create({
    data: { id: "customer-legacy", name: "Legacy Customer", email: "billing@example.com" },
  });
  const order = await prisma.order.create({
    data: { id: "order-legacy", customerId: customer.id, reference: "SO-LEGACY" },
  });
  const invoice = await prisma.invoice.create({
    data: {
      id: "invoice-legacy",
      number: "INV-LEGACY",
      customerId: customer.id,
      orderId: order.id,
      issueDate: new Date("2026-02-28T23:30:00-08:00"),
      dueDate: new Date("2026-04-01T07:30:00.000Z"),
      total: 0.3,
      amountPaid: 0.1,
      lines: {
        create: {
          id: "line-legacy",
          description: "Legacy metered usage",
          quantity: 3,
          unitPrice: 0.1,
          amount: 0.3,
        },
      },
    },
  });
  const payment = await prisma.payment.create({
    data: { id: "payment-legacy", customerId: customer.id, amount: 0.1 },
  });
  await prisma.paymentApplication.create({
    data: {
      id: "application-legacy",
      invoiceId: invoice.id,
      paymentId: payment.id,
      amount: 0.1,
    },
  });

  const preview = await runInvoiceDecimalBackfill({ batchSize: 1, dryRun: true });
  assert.equal(preview.state, "COMPLETE");
  assert.equal(preview.rowsRead, 1);
  assert.equal(preview.rowsWritten, 0);
  assert.equal(
    await prisma.backfillCheckpoint.findUnique({
      where: { jobName: INVOICE_DECIMAL_BACKFILL_JOB },
    }),
    null
  );
  assert.equal(
    (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).totalDecimal,
    null
  );

  const applied = await runInvoiceDecimalBackfill({ batchSize: 1 });
  assert.equal(applied.state, "COMPLETE");
  assert.equal(applied.rowsWritten, 1);

  const storedInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { lines: true },
  });
  assert.equal(storedInvoice.totalDecimal?.toFixed(4), "0.3000");
  assert.equal(storedInvoice.amountPaidDecimal?.toFixed(4), "0.1000");
  assert.equal(storedInvoice.accountingDate, "2026-03-01");
  assert.equal(storedInvoice.lines[0]?.quantityDecimal?.toFixed(6), "3.000000");
  assert.equal(storedInvoice.lines[0]?.unitPriceDecimal?.toFixed(4), "0.1000");
  assert.equal(storedInvoice.lines[0]?.amountDecimal?.toFixed(4), "0.3000");

  const checkpoint = await prisma.backfillCheckpoint.findUniqueOrThrow({
    where: { jobName: INVOICE_DECIMAL_BACKFILL_JOB },
  });
  assert.equal(checkpoint.lastId, invoice.id);
  assert.notEqual(checkpoint.completedAt, null);

  const restarted = await runInvoiceDecimalBackfill({ batchSize: 1 });
  assert.equal(restarted.state, "COMPLETE");
  assert.equal(restarted.rowsRead, 0);
  assert.equal(restarted.rowsWritten, 0);
  assert.equal(restarted.checkpoint, invoice.id);
}

void main().finally(() => prisma.$disconnect());
