import assert from "node:assert/strict";
import { prisma } from "../db";
import { LEGACY_DEFAULT_TENANT_ID, runTenantBackfill } from "./tenantBackfill";

async function main(): Promise<void> {
  await prisma.tenant.create({
    data: { id: LEGACY_DEFAULT_TENANT_ID, slug: "reserved-legacy-id", name: "Reserved tenant" },
  });
  await prisma.customer.create({ data: { id: "legacy-customer", name: "Legacy customer", email: "legacy@example.com" } });

  const preview = await runTenantBackfill();
  assert.equal(preview.state, "COMPLETE");
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "legacy-customer" } })).tenantId, null);

  const write = await runTenantBackfill({ dryRun: false });
  assert.equal(write.state, "PARTIAL");
  assert.equal(write.tenantId, null);
  assert.equal(write.stages[0]?.name, "TENANT");
  assert.equal(write.stages[0]?.result.stop?.code, "LEGACY_DEFAULT_TENANT_IDENTITY_CONFLICT");
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: "legacy-customer" } })).tenantId, null);
}

void main().finally(() => prisma.$disconnect());
