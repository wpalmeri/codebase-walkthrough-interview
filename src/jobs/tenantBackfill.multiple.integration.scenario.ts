import assert from "node:assert/strict";
import { prisma } from "../db";
import { runTenantBackfill } from "./tenantBackfill";

async function main(): Promise<void> {
  const [first, second] = await Promise.all([
    prisma.tenant.create({ data: { id: "tenant-first", slug: "first", name: "First tenant" } }),
    prisma.tenant.create({ data: { id: "tenant-second", slug: "second", name: "Second tenant" } }),
  ]);
  const customer = await prisma.customer.create({
    data: { id: "legacy-customer", name: "Legacy customer", email: "legacy@example.com" },
  });
  await prisma.order.create({ data: { id: "first-order", tenantId: first.id, customerId: customer.id } });
  await prisma.payment.create({ data: { id: "second-payment", tenantId: second.id, customerId: customer.id, amount: 1 } });

  const result = await runTenantBackfill({ dryRun: false });
  assert.equal(result.state, "PARTIAL");
  assert.equal(result.stages[0]?.result.stop?.code, "MULTIPLE_RELATED_TENANTS");
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).tenantId, null);
}

void main().finally(() => prisma.$disconnect());
