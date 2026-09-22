import assert from "node:assert/strict";
import { prisma } from "../db";
import { legacyNumber } from "../domain/money";
import { captureOrderPricing, exactPricingInput } from "../domain/orderPricing";
import {
  INVOICE_SNAPSHOT_BACKFILL_JOB,
  runInvoiceSnapshotBackfill,
} from "./invoiceSnapshotBackfill";

const moneyFormat = { scale: 4, precision: 19, field: "amount" } as const;
const quantityFormat = { scale: 6, precision: 19, field: "quantity" } as const;

async function main(): Promise<void> {
  const customer = await prisma.customer.create({
    data: {
      id: "customer-historical",
      name: "Historical Customer",
      email: "historical@example.com",
    },
  });
  const product = await prisma.product.create({
    data: {
      id: "product-historical",
      sku: "HISTORICAL-SKU",
      name: "Historical Product",
      unit: "seat",
      listPrice: 4.5,
      listPriceDecimal: "4.5000",
      currencyCode: "USD",
    },
  });
  const rate = await prisma.rate.create({
    data: {
      id: "rate-historical",
      customerId: customer.id,
      productId: product.id,
      unitPrice: 4.5,
      unitPriceDecimal: "4.5000",
      currencyCode: "USD",
    },
  });
  const captured = captureOrderPricing(
    exactPricingInput({
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        currencyCode: "USD",
      },
      rate: {
        id: rate.id,
        currencyCode: "USD",
        baseUnitPrice: "4.5000",
        tiers: [],
      },
      quantity: "2",
      discounts: [],
      capturedAt: "2026-01-15T12:00:00.000Z",
    })
  );
  const order = await prisma.order.create({
    data: {
      id: "order-historical",
      customerId: customer.id,
      status: "INVOICED",
      currencyCode: "USD",
      items: {
        create: {
          id: "item-historical",
          productId: product.id,
          rateId: rate.id,
          quantity: legacyNumber(captured.quantityDecimal, quantityFormat),
          unitPrice: legacyNumber(captured.effectiveUnitPriceDecimal, moneyFormat),
          productSkuSnapshot: captured.productSkuSnapshot,
          productNameSnapshot: captured.productNameSnapshot,
          productUnitSnapshot: captured.productUnitSnapshot,
          quantityDecimal: captured.quantityDecimal,
          baseUnitPriceDecimal: captured.baseUnitPriceDecimal,
          effectiveUnitPriceDecimal: captured.effectiveUnitPriceDecimal,
          amountDecimal: captured.amountDecimal,
          pricingCapturedAt: new Date(captured.pricingCapturedAt),
          snapshotVersion: captured.snapshotVersion,
          pricingSnapshot: captured.pricingSnapshot,
        },
      },
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      id: "invoice-historical",
      number: "INV-HISTORICAL",
      customerId: customer.id,
      orderId: order.id,
      dueDate: new Date("2026-02-15T12:00:00.000Z"),
      total: 9,
      totalDecimal: "9.0000",
      amountPaid: 0,
      amountPaidDecimal: "0.0000",
      accountingDate: "2026-01-15",
      currencyCode: "USD",
      customerNameSnapshot: "Historical Customer",
      customerEmailSnapshot: "historical@example.com",
      lines: {
        create: {
          id: "line-historical",
          description: "Historical Product @ seat",
          quantity: 2,
          unitPrice: 4.5,
          amount: 9,
          quantityDecimal: "2.000000",
          unitPriceDecimal: "4.5000",
          amountDecimal: "9.0000",
        },
      },
    },
  });
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "POSTED", postedAt: new Date("2026-01-15T12:00:00.000Z") },
  });

  // These mutable current rows must never be consulted as historical evidence.
  await prisma.customer.update({
    where: { id: customer.id },
    data: { name: "Current Customer", email: "current@example.com" },
  });
  await prisma.product.update({
    where: { id: product.id },
    data: { sku: "CURRENT-SKU", name: "Current Product", unit: "day" },
  });
  await prisma.rate.update({ where: { id: rate.id }, data: { unitPrice: 999 } });

  const preview = await runInvoiceSnapshotBackfill({ batchSize: 1 });
  assert.equal(preview.state, "COMPLETE");
  assert.equal(preview.dryRun, true);
  assert.equal(
    (await prisma.invoiceLine.findUniqueOrThrow({ where: { id: "line-historical" } }))
      .productSkuSnapshot,
    null
  );
  assert.equal(
    await prisma.backfillCheckpoint.findUnique({
      where: { jobName: INVOICE_SNAPSHOT_BACKFILL_JOB },
    }),
    null
  );

  const applied = await runInvoiceSnapshotBackfill({ batchSize: 1, dryRun: false });
  assert.equal(applied.state, "COMPLETE");
  const [storedInvoice, storedLine] = await Promise.all([
    prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
    prisma.invoiceLine.findUniqueOrThrow({ where: { id: "line-historical" } }),
  ]);
  assert.equal(storedInvoice.customerNameSnapshot, "Historical Customer");
  assert.equal(storedInvoice.customerEmailSnapshot, "historical@example.com");
  assert.equal(storedLine.productSkuSnapshot, "HISTORICAL-SKU");
  assert.equal(storedLine.productUnitSnapshot, "seat");
  assert.notEqual(
    (
      await prisma.backfillCheckpoint.findUniqueOrThrow({
        where: { jobName: INVOICE_SNAPSHOT_BACKFILL_JOB },
      })
    ).completedAt,
    null
  );

  const restarted = await runInvoiceSnapshotBackfill({ batchSize: 1, dryRun: false });
  assert.equal(restarted.rowsRead, 0);
  assert.equal(restarted.rowsWritten, 0);
}

void main().finally(() => prisma.$disconnect());
