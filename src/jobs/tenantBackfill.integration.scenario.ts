import assert from "node:assert/strict";
import { prisma } from "../db";
import {
  LEGACY_DEFAULT_TENANT_ID,
  LEGACY_DEFAULT_TENANT_SLUG,
  runTenantBackfill,
} from "./tenantBackfill";

async function seedLegacyGraph(prefix: string): Promise<void> {
  const customer = await prisma.customer.create({
    data: { id: `${prefix}-customer`, name: `${prefix} customer`, email: `${prefix}@example.com` },
  });
  const product = await prisma.product.create({
    data: { id: `${prefix}-product`, sku: `${prefix}-sku`, name: `${prefix} product`, unit: "seat", listPrice: 1 },
  });
  const rate = await prisma.rate.create({
    data: { id: `${prefix}-rate`, customerId: customer.id, productId: product.id, unitPrice: 1 },
  });
  await prisma.comboDiscount.create({
    data: {
      id: `${prefix}-discount`,
      customerId: customer.id,
      name: `${prefix} discount`,
      percentOff: 1,
      products: { connect: { id: product.id } },
    },
  });
  const order = await prisma.order.create({
    data: {
      id: `${prefix}-order`,
      customerId: customer.id,
      items: { create: { id: `${prefix}-item`, productId: product.id, rateId: rate.id, quantity: 1, unitPrice: 1 } },
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      id: `${prefix}-invoice`,
      number: `${prefix}-invoice-number`,
      customerId: customer.id,
      orderId: order.id,
      dueDate: new Date("2026-10-01T00:00:00.000Z"),
      total: 1,
    },
  });
  const payment = await prisma.payment.create({
    data: { id: `${prefix}-payment`, customerId: customer.id, amount: 1 },
  });
  await prisma.paymentApplication.create({
    data: { id: `${prefix}-application`, paymentId: payment.id, invoiceId: invoice.id, amount: 1 },
  });
  await prisma.idempotencyRecord.create({
    data: {
      id: `${prefix}-idempotency`,
      clientScope: `${prefix}-scope`,
      method: "POST",
      route: "/v1/orders",
      idempotencyKey: `${prefix}-key`,
      requestFingerprint: `${prefix}-fingerprint`,
    },
  });
}

async function main(): Promise<void> {
  await seedLegacyGraph("a");
  await seedLegacyGraph("b");
  await prisma.accountingPeriodControl.create({ data: { id: 1, closedThroughDate: "2026-09-21" } });

  const preview = await runTenantBackfill({ batchSize: 1 });
  assert.equal(preview.state, "COMPLETE");
  assert.equal(preview.dryRun, true);
  assert.equal(await prisma.tenant.findUnique({ where: { slug: LEGACY_DEFAULT_TENANT_SLUG } }), null);
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "a-customer" } })).tenantId, null);
  assert.equal(
    await prisma.backfillCheckpoint.findUnique({ where: { jobName: "tenant-ownership-customer-v1" } }),
    null
  );

  let waits = 0;
  await assert.rejects(
    () =>
      runTenantBackfill(
        { batchSize: 1, dryRun: false },
        {
          wait: async () => {
            waits += 1;
            if (waits === 1) throw new Error("intentional interruption after a committed batch");
          },
        }
      ),
    /intentional interruption/u
  );
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "a-customer" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "b-customer" } })).tenantId, null);
  assert.equal(
    (await prisma.backfillCheckpoint.findUniqueOrThrow({ where: { jobName: "tenant-ownership-customer-v1" } })).lastId,
    "a-customer"
  );

  const other = await prisma.tenant.create({ data: { id: "tenant-other", slug: "other", name: "Other tenant" } });
  await prisma.customer.create({
    data: { id: "already-owned-customer", tenantId: other.id, name: "Already owned", email: "owned@example.com" },
  });

  const applied = await runTenantBackfill({ batchSize: 1, dryRun: false });
  assert.equal(applied.state, "COMPLETE");
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "b-customer" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal(
    (await prisma.customer.findUniqueOrThrow({ where: { id: "already-owned-customer" } })).tenantId,
    other.id
  );
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: "a-product" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal((await prisma.comboDiscount.findUniqueOrThrow({ where: { id: "a-discount" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: "a-order" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: "a-invoice" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: "a-payment" } })).tenantId, LEGACY_DEFAULT_TENANT_ID);
  assert.equal(
    (await prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: "a-idempotency" } })).tenantId,
    LEGACY_DEFAULT_TENANT_ID
  );
  assert.equal(
    (await prisma.tenantAccountingPeriodControl.findUniqueOrThrow({ where: { tenantId: LEGACY_DEFAULT_TENANT_ID } }))
      .closedThroughDate,
    "2026-09-21"
  );

  const restarted = await runTenantBackfill({ batchSize: 1, dryRun: false });
  assert.equal(restarted.state, "COMPLETE");
  assert.ok(restarted.stages.every((stage) => stage.result.rowsWritten === 0));
}

void main().finally(() => prisma.$disconnect());
