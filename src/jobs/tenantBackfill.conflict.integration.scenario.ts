import assert from "node:assert/strict";
import { prisma } from "../db";
import { runTenantBackfill } from "./tenantBackfill";

async function main(): Promise<void> {
  const other = await prisma.tenant.create({ data: { id: "tenant-other", slug: "other", name: "Other tenant" } });
  await prisma.customer.create({ data: { id: "a-good", name: "Good legacy", email: "good@example.com" } });
  const conflicted = await prisma.customer.create({
    data: { id: "z-conflicted", name: "Conflicted legacy", email: "conflicted@example.com" },
  });
  // Nullable expand-mode ownership intentionally permits this historical edge;
  // the backfill must reject it rather than silently assigning the customer.
  await prisma.order.create({
    data: { id: "other-order", tenantId: other.id, customerId: conflicted.id },
  });

  const result = await runTenantBackfill({ batchSize: 100, dryRun: false });
  assert.equal(result.state, "PARTIAL");
  const customerStage = result.stages[0];
  assert.equal(customerStage?.name, "CUSTOMER");
  assert.equal(customerStage?.result.stop?.code, "CONFLICTING_ORDER_OWNERSHIP");
  // The good row was in the same candidate batch: validation occurs before the
  // transaction, so a conflict leaves the whole batch and checkpoint untouched.
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "a-good" } })).tenantId, null);
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: conflicted.id } })).tenantId, null);
  assert.equal(
    await prisma.backfillCheckpoint.findUnique({ where: { jobName: "tenant-ownership-customer-v1" } }),
    null
  );
}

void main().finally(() => prisma.$disconnect());
