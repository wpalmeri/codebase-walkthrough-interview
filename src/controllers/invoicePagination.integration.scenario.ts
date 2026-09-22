import assert from "node:assert/strict";
import { fingerprintPaginationFilters, formatPaginationCursor } from "@meridian/contracts";
import { prisma } from "../db";
import { listInvoices, listInvoicesPage } from "./invoiceController";

async function main(): Promise<void> {
  try {
    await prisma.customer.createMany({ data: [
      { id: "invoice-page-customer-a", name: "Customer A", email: "a@example.com" },
      { id: "invoice-page-customer-b", name: "Customer B", email: "b@example.com" },
    ] });
    await prisma.order.createMany({ data: [
      { id: "invoice-page-order-a", customerId: "invoice-page-customer-a" },
      { id: "invoice-page-order-b", customerId: "invoice-page-customer-b" },
      { id: "invoice-page-order-c", customerId: "invoice-page-customer-a" },
    ] });
    await prisma.invoice.createMany({ data: [
      { id: "invoice-page-001", number: "PAGE-001", customerId: "invoice-page-customer-a", orderId: "invoice-page-order-a", issueDate: new Date("2026-01-03T00:00:00.000Z"), dueDate: new Date("2026-02-01T00:00:00.000Z") },
      { id: "invoice-page-002", number: "PAGE-002", customerId: "invoice-page-customer-b", orderId: "invoice-page-order-b", issueDate: new Date("2026-01-02T00:00:00.000Z"), dueDate: new Date("2026-02-01T00:00:00.000Z") },
      { id: "invoice-page-003", number: "PAGE-003", customerId: "invoice-page-customer-a", orderId: "invoice-page-order-c", issueDate: new Date("2026-01-01T00:00:00.000Z"), dueDate: new Date("2026-02-01T00:00:00.000Z") },
    ] });
    assert.deepEqual((await listInvoices()).map((invoice) => invoice.id), ["invoice-page-001", "invoice-page-002", "invoice-page-003"]);
    const first = await listInvoicesPage({ limit: 2 });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("first page must parse");
    assert.deepEqual(first.page.data.map((invoice) => invoice.id), ["invoice-page-001", "invoice-page-002"]);
    const second = await listInvoicesPage({ limit: 2, cursor: first.page.page.nextCursor ?? undefined });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("second page must parse");
    assert.deepEqual(second.page.data.map((invoice) => invoice.id), ["invoice-page-003"]);
    const mismatch = await listInvoicesPage({
      limit: 2,
      cursor: formatPaginationCursor({ resource: "payments", filterFingerprint: fingerprintPaginationFilters({}), ordering: ["2026-01-03T00:00:00.000Z", "invoice-page-001"] }),
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
