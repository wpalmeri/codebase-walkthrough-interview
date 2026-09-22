import assert from "node:assert/strict";
import { prisma } from "../db";
import {
  PAYMENT_APPLICATION_FINANCIAL_BACKFILL_JOB,
  PRODUCT_FINANCIAL_BACKFILL_JOB,
  runLegacyFinancialBackfill,
} from "./legacyFinancialBackfill";

async function main(): Promise<void> {
  const customer = await prisma.customer.create({
    data: { id: "customer-legacy", name: "Legacy Customer", email: "billing@example.com" },
  });
  const product = await prisma.product.create({
    data: { id: "product-legacy", sku: "LEGACY", name: "Legacy Product", unit: "month", listPrice: 1.25 },
  });
  await prisma.rate.create({
    data: {
      id: "rate-legacy",
      customerId: customer.id,
      productId: product.id,
      unitPrice: 1.25,
      tiers: [{ upTo: 10, unitPrice: 1.25 }, { upTo: null, unitPrice: 1 }],
    },
  });
  await prisma.comboDiscount.create({
    data: { id: "discount-legacy", customerId: customer.id, name: "Legacy discount", percentOff: 5 },
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
      dueDate: new Date("2026-03-01T00:00:00.000Z"),
      total: 5,
      amountPaid: 5,
    },
  });
  const payment = await prisma.payment.create({
    data: { id: "payment-legacy", customerId: customer.id, amount: 5 },
  });
  await prisma.paymentApplication.create({
    data: { id: "application-legacy", paymentId: payment.id, invoiceId: invoice.id, amount: 5 },
  });

  const preview = await runLegacyFinancialBackfill({ batchSize: 1 });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.state, "COMPLETE");
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).listPriceDecimal, null);
  assert.equal(
    await prisma.backfillCheckpoint.findUnique({ where: { jobName: PRODUCT_FINANCIAL_BACKFILL_JOB } }),
    null
  );

  const applied = await runLegacyFinancialBackfill({ batchSize: 1, dryRun: false });
  assert.equal(applied.state, "COMPLETE");
  const [storedProduct, storedRate, storedDiscount, storedPayment, storedApplication] = await Promise.all([
    prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
    prisma.rate.findUniqueOrThrow({ where: { id: "rate-legacy" } }),
    prisma.comboDiscount.findUniqueOrThrow({ where: { id: "discount-legacy" } }),
    prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
    prisma.paymentApplication.findUniqueOrThrow({ where: { id: "application-legacy" } }),
  ]);
  assert.equal(storedProduct.listPriceDecimal?.toFixed(4), "1.2500");
  assert.equal(storedProduct.currencyCode, "USD");
  assert.equal(storedRate.unitPriceDecimal?.toFixed(4), "1.2500");
  assert.equal(storedRate.currencyCode, "USD");
  assert.deepEqual(storedRate.tiers, [
    { upTo: "10.000000", unitPrice: "1.2500" },
    { upTo: null, unitPrice: "1.0000" },
  ]);
  assert.equal(storedDiscount.percentOffDecimal?.toFixed(4), "5.0000");
  assert.equal(storedPayment.amountDecimal?.toFixed(4), "5.0000");
  assert.equal(storedPayment.currencyCode, "USD");
  assert.equal(storedApplication.amountDecimal?.toFixed(4), "5.0000");
  assert.notEqual(
    (await prisma.backfillCheckpoint.findUniqueOrThrow({
      where: { jobName: PAYMENT_APPLICATION_FINANCIAL_BACKFILL_JOB },
    })).completedAt,
    null
  );

  const restarted = await runLegacyFinancialBackfill({ batchSize: 1, dryRun: false });
  assert.equal(restarted.state, "COMPLETE");
  assert.ok(restarted.stages.every((stage) => stage.result.rowsRead === 0));
}

void main().finally(() => prisma.$disconnect());
