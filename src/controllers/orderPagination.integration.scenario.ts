import assert from "node:assert/strict";
import {
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
} from "@meridian/contracts";
import { prisma } from "../db";
import { listOrders, listOrdersPage } from "./orderController";

const tenantA = "order-controller-page-tenant-a";
const tenantB = "order-controller-page-tenant-b";
const originalOrderIds = [
  "order-controller-a-002",
  "order-controller-a-001",
  "order-controller-a-003",
  "order-controller-a-004",
];

async function seed(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Order Controller Tenant A" },
      { id: tenantB, slug: tenantB, name: "Order Controller Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: "order-controller-customer-a", tenantId: tenantA, name: "Controller Customer A", email: "a@example.com" },
      { id: "order-controller-customer-b", tenantId: tenantB, name: "Controller Customer B", email: "b@example.com" },
    ],
  });
  await prisma.order.createMany({
    data: [
      { id: "order-controller-a-001", tenantId: tenantA, customerId: "order-controller-customer-a", orderDate: new Date("2026-01-02T10:00:00.000Z") },
      { id: "order-controller-a-002", tenantId: tenantA, customerId: "order-controller-customer-a", orderDate: new Date("2026-01-02T10:00:00.000Z") },
      { id: "order-controller-a-003", tenantId: tenantA, customerId: "order-controller-customer-a", orderDate: new Date("2026-01-02T09:00:00.000Z") },
      { id: "order-controller-a-004", tenantId: tenantA, customerId: "order-controller-customer-a", orderDate: new Date("2026-01-02T08:00:00.000Z") },
      { id: "order-controller-b-001", tenantId: tenantB, customerId: "order-controller-customer-b", orderDate: new Date("2026-01-02T11:00:00.000Z") },
      { id: "order-controller-b-002", tenantId: tenantB, customerId: "order-controller-customer-b", orderDate: new Date("2026-01-02T07:00:00.000Z") },
    ],
  });
}

function page(result: Awaited<ReturnType<typeof listOrdersPage>>) {
  if (!result.ok) throw new Error(`expected order page, received ${result.code}`);
  return result.page;
}

async function main(): Promise<void> {
  await seed();
  const indexes = await prisma.$queryRaw<readonly { name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'Order_tenantId_orderDate_id_idx'
  `;
  assert.deepEqual(indexes, [{ name: "Order_tenantId_orderDate_id_idx" }]);

  // Legacy behavior intentionally remains a complete bare array. Its existing
  // orderDate-only sort has no tie-breaker, unlike the v1 cursor contract.
  assert.deepEqual((await listOrders(tenantA)).map(({ id }) => id).toSorted(), originalOrderIds.toSorted());

  const first = page(await listOrdersPage(tenantA, { limit: 2 }));
  assert.deepEqual(first.data.map(({ id }) => id), originalOrderIds.slice(0, 2));
  assert.ok(first.page.nextCursor !== null);

  await prisma.order.create({
    data: {
      id: "order-controller-a-interleaved",
      tenantId: tenantA,
      customerId: "order-controller-customer-a",
      orderDate: new Date("2026-01-02T11:00:00.000Z"),
    },
  });
  const received = first.data.map(({ id }) => id);
  let cursor: string | null = first.page.nextCursor;
  while (cursor !== null) {
    const next = page(await listOrdersPage(tenantA, { limit: 2, cursor }));
    received.push(...next.data.map(({ id }) => id));
    cursor = next.page.nextCursor;
  }
  assert.deepEqual(received, originalOrderIds, "tied dates and an interleaved insert preserve original traversal");

  const malformed = await listOrdersPage(tenantA, { limit: 2, cursor: "not-an-order-cursor" });
  assert.deepEqual(malformed, { ok: false, code: "CURSOR_MALFORMED" });

  const resourceMismatch = await listOrdersPage(tenantA, {
    limit: 2,
    cursor: formatPaginationCursor({
      resource: "payments",
      filterFingerprint: fingerprintTenantPaginationBinding({}, tenantA),
      ordering: ["2026-01-02T10:00:00.000Z", "order-controller-a-001"],
    }),
  });
  assert.deepEqual(resourceMismatch, { ok: false, code: "CURSOR_RESOURCE_MISMATCH" });

  const filterMismatch = await listOrdersPage(tenantA, {
    limit: 2,
    cursor: formatPaginationCursor({
      resource: "orders",
      filterFingerprint: fingerprintTenantPaginationBinding({ unsupportedFilter: "yes" }, tenantA),
      ordering: ["2026-01-02T10:00:00.000Z", "order-controller-a-001"],
    }),
  });
  assert.deepEqual(filterMismatch, { ok: false, code: "CURSOR_FILTER_MISMATCH" });

  const tenantBPage = page(await listOrdersPage(tenantB, { limit: 1 }));
  assert.ok(tenantBPage.page.nextCursor !== null);
  const tenantMismatch = await listOrdersPage(tenantA, {
    limit: 1,
    cursor: tenantBPage.page.nextCursor ?? "",
  });
  assert.deepEqual(tenantMismatch, { ok: false, code: "CURSOR_FILTER_MISMATCH" });
}

void main().finally(() => prisma.$disconnect());
