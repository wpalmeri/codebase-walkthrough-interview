import assert from "node:assert/strict";
import { prisma } from "../db";
import { captureOrderPricing, exactPricingInput } from "../domain/orderPricing";
import {
  ORDER_PRICING_SNAPSHOT_BACKFILL_JOB,
  runOrderPricingSnapshotBackfill,
} from "./orderPricingSnapshotBackfill";

async function main(): Promise<void> {
  const customer = await prisma.customer.create({
    data: { id: "customer-legacy", name: "Legacy Customer", email: "billing@example.com" },
  });
  const product = await prisma.product.create({
    data: { id: "product-live", sku: "LIVE-SKU", name: "Live Product", unit: "month", listPrice: 100 },
  });
  const rate = await prisma.rate.create({
    data: { id: "rate-live", customerId: customer.id, productId: product.id, unitPrice: 100 },
  });
  const captured = captureOrderPricing(
    exactPricingInput({
      product: { id: product.id, sku: "HISTORICAL-SKU", name: "Historical Product", unit: "seat", currencyCode: "USD" },
      rate: { id: rate.id, currencyCode: "USD", baseUnitPrice: "2.5", tiers: [] },
      quantity: "4",
      discounts: [{ id: "discount-historical", name: "Historical discount", percentOff: "10" }],
      capturedAt: "2026-01-15T12:00:00.000Z",
    })
  );
  const order = await prisma.order.create({
    data: { id: "order-legacy", customerId: customer.id, reference: "SO-LEGACY" },
  });
  const item = await prisma.orderItem.create({
    data: {
      id: "item-legacy",
      orderId: order.id,
      productId: product.id,
      rateId: rate.id,
      quantity: 4,
      unitPrice: 2.25,
      pricingSnapshot: captured.pricingSnapshot,
    },
  });

  // These current catalog mutations must have no effect: the job reads only
  // Order and OrderItem rows, and uses the persisted pricingSnapshot as proof.
  await prisma.product.update({
    where: { id: product.id },
    data: { sku: "MUTATED-SKU", name: "Mutated Product", unit: "day", listPrice: 999 },
  });
  await prisma.rate.update({ where: { id: rate.id }, data: { unitPrice: 999 } });

  const preview = await runOrderPricingSnapshotBackfill({ batchSize: 1 });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.state, "COMPLETE");
  assert.equal((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).amountDecimal, null);
  assert.equal(
    await prisma.backfillCheckpoint.findUnique({ where: { jobName: ORDER_PRICING_SNAPSHOT_BACKFILL_JOB } }),
    null
  );

  const applied = await runOrderPricingSnapshotBackfill({ batchSize: 1, dryRun: false });
  assert.equal(applied.state, "COMPLETE");
  const [storedOrder, storedItem] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } }),
  ]);
  assert.equal(storedOrder.currencyCode, "USD");
  assert.equal(storedItem.productSkuSnapshot, "HISTORICAL-SKU");
  assert.equal(storedItem.productNameSnapshot, "Historical Product");
  assert.equal(storedItem.productUnitSnapshot, "seat");
  assert.equal(storedItem.amountDecimal?.toFixed(4), "9.0000");
  assert.equal(storedItem.baseUnitPriceDecimal?.toFixed(4), "2.5000");
  assert.equal(storedItem.effectiveUnitPriceDecimal?.toFixed(4), "2.2500");
  assert.notEqual(
    (await prisma.backfillCheckpoint.findUniqueOrThrow({
      where: { jobName: ORDER_PRICING_SNAPSHOT_BACKFILL_JOB },
    })).completedAt,
    null
  );

  const restarted = await runOrderPricingSnapshotBackfill({ batchSize: 1, dryRun: false });
  assert.equal(restarted.state, "COMPLETE");
  assert.equal(restarted.rowsRead, 0);
  assert.equal(restarted.rowsWritten, 0);
}

void main().finally(() => prisma.$disconnect());
