import assert from "node:assert/strict";
import { fingerprintPaginationFilters, formatPaginationCursor } from "@meridian/contracts";
import { prisma } from "../db";
import { listOrders, listOrdersPage } from "./orderController";

async function main(): Promise<void> {
  try {
    await prisma.customer.createMany({ data: [
      { id: "order-page-customer-a", name: "Customer A", email: "a@example.com" },
      { id: "order-page-customer-b", name: "Customer B", email: "b@example.com" },
    ] });
    await prisma.order.createMany({ data: [
      { id: "order-page-001", customerId: "order-page-customer-a", orderDate: new Date("2026-01-03T00:00:00.000Z") },
      { id: "order-page-002", customerId: "order-page-customer-b", orderDate: new Date("2026-01-02T00:00:00.000Z") },
      { id: "order-page-003", customerId: "order-page-customer-a", orderDate: new Date("2026-01-01T00:00:00.000Z") },
    ] });
    assert.deepEqual((await listOrders()).map((order) => order.id), ["order-page-001", "order-page-002", "order-page-003"]);
    const first = await listOrdersPage({ limit: 2 });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("first page must parse");
    assert.deepEqual(first.page.data.map((order) => order.id), ["order-page-001", "order-page-002"]);
    assert.ok(first.page.page.nextCursor);
    const second = await listOrdersPage({ limit: 2, cursor: first.page.page.nextCursor ?? undefined });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("second page must parse");
    assert.deepEqual(second.page.data.map((order) => order.id), ["order-page-003"]);
    const mismatch = await listOrdersPage({
      limit: 2,
      cursor: formatPaginationCursor({ resource: "invoices", filterFingerprint: fingerprintPaginationFilters({}), ordering: ["2026-01-03T00:00:00.000Z", "order-page-001"] }),
    });
    assert.deepEqual(mismatch, { ok: false, code: "CURSOR_RESOURCE_MISMATCH" });
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
