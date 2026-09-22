import assert from "node:assert/strict";
import { fingerprintTenantPaginationBinding, formatPaginationCursor } from "@meridian/contracts";
import { prisma } from "../db";
import { listInvoices, listInvoicesPage } from "./invoiceController";

const tenantA = "invoice-controller-page-tenant-a";
const tenantB = "invoice-controller-page-tenant-b";
const originalInvoiceIds = [
  "invoice-controller-a-002",
  "invoice-controller-a-001",
  "invoice-controller-a-003",
  "invoice-controller-a-004",
];

async function createInvoice(tenantId: string, customerId: string, suffix: string, issueDate: string): Promise<void> {
  const orderId = `order-${suffix}`;
  await prisma.order.create({
    data: { id: orderId, tenantId, customerId, orderDate: new Date(issueDate) },
  });
  await prisma.invoice.create({
    data: {
      id: `invoice-${suffix}`,
      tenantId,
      number: `INV-${suffix}`,
      customerId,
      orderId,
      issueDate: new Date(issueDate),
      dueDate: new Date("2026-02-01T00:00:00.000Z"),
    },
  });
}

async function seed(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Invoice Controller Tenant A" },
      { id: tenantB, slug: tenantB, name: "Invoice Controller Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: "invoice-controller-customer-a", tenantId: tenantA, name: "Invoice Customer A", email: "a@example.com" },
      { id: "invoice-controller-customer-b", tenantId: tenantB, name: "Invoice Customer B", email: "b@example.com" },
    ],
  });
  await Promise.all([
    createInvoice(tenantA, "invoice-controller-customer-a", "controller-a-001", "2026-01-02T10:00:00.000Z"),
    createInvoice(tenantA, "invoice-controller-customer-a", "controller-a-002", "2026-01-02T10:00:00.000Z"),
    createInvoice(tenantA, "invoice-controller-customer-a", "controller-a-003", "2026-01-02T09:00:00.000Z"),
    createInvoice(tenantA, "invoice-controller-customer-a", "controller-a-004", "2026-01-02T08:00:00.000Z"),
    createInvoice(tenantB, "invoice-controller-customer-b", "controller-b-001", "2026-01-02T11:00:00.000Z"),
    createInvoice(tenantB, "invoice-controller-customer-b", "controller-b-002", "2026-01-02T07:00:00.000Z"),
  ]);
}

function page(result: Awaited<ReturnType<typeof listInvoicesPage>>) {
  if (!result.ok) throw new Error(`expected invoice page, received ${result.code}`);
  return result.page;
}

async function main(): Promise<void> {
  await seed();
  const indexes = await prisma.$queryRaw<readonly { name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'Invoice_tenantId_issueDate_id_idx'
  `;
  assert.deepEqual(indexes, [{ name: "Invoice_tenantId_issueDate_id_idx" }]);

  assert.deepEqual((await listInvoices(tenantA)).map(({ id }) => id).toSorted(), originalInvoiceIds.toSorted());

  const first = page(await listInvoicesPage(tenantA, { limit: 2 }));
  assert.deepEqual(first.data.map(({ id }) => id), originalInvoiceIds.slice(0, 2));
  assert.deepEqual(first.data[0], {
    id: "invoice-controller-a-002",
    number: "INV-controller-a-002",
    customerId: "invoice-controller-customer-a",
    customerName: "Invoice Customer A",
    customerEmail: "a@example.com",
    billingAddress: null,
    orderId: "order-controller-a-002",
    orderReference: null,
    status: "DRAFT",
    issueDate: "2026-01-02T10:00:00.000Z",
    dueDate: "2026-02-01T00:00:00.000Z",
    accountingDate: undefined,
    total: 0,
    amountPaid: 0,
    totalDecimal: "0.0000",
    amountPaidDecimal: "0.0000",
    currencyCode: undefined,
    balance: 0,
    balanceDecimal: "0.0000",
    postedAt: null,
    lines: [], payments: [], transmissions: [], lastTransmission: null,
  });
  assert.ok(first.page.nextCursor !== null);

  await createInvoice(tenantA, "invoice-controller-customer-a", "controller-a-interleaved", "2026-01-02T11:00:00.000Z");
  const received = first.data.map(({ id }) => id);
  let cursor: string | null = first.page.nextCursor;
  while (cursor !== null) {
    const next = page(await listInvoicesPage(tenantA, { limit: 2, cursor }));
    received.push(...next.data.map(({ id }) => id));
    cursor = next.page.nextCursor;
  }
  assert.deepEqual(received, originalInvoiceIds, "tied dates and an interleaved insert preserve original traversal");

  assert.deepEqual(
    await listInvoicesPage(tenantA, { limit: 2, cursor: "not-an-invoice-cursor" }),
    { ok: false, code: "CURSOR_MALFORMED" }
  );
  assert.deepEqual(
    await listInvoicesPage(tenantA, {
      limit: 2,
      cursor: formatPaginationCursor({
        resource: "payments",
        filterFingerprint: fingerprintTenantPaginationBinding({}, tenantA),
        ordering: ["2026-01-02T10:00:00.000Z", "invoice-controller-a-001"],
      }),
    }),
    { ok: false, code: "CURSOR_RESOURCE_MISMATCH" }
  );
  assert.deepEqual(
    await listInvoicesPage(tenantA, {
      limit: 2,
      cursor: formatPaginationCursor({
        resource: "invoices",
        filterFingerprint: fingerprintTenantPaginationBinding({ unsupportedFilter: "yes" }, tenantA),
        ordering: ["2026-01-02T10:00:00.000Z", "invoice-controller-a-001"],
      }),
    }),
    { ok: false, code: "CURSOR_FILTER_MISMATCH" }
  );
  const tenantBPage = page(await listInvoicesPage(tenantB, { limit: 1 }));
  assert.ok(tenantBPage.page.nextCursor !== null);
  assert.deepEqual(
    await listInvoicesPage(tenantA, { limit: 1, cursor: tenantBPage.page.nextCursor ?? "" }),
    { ok: false, code: "CURSOR_FILTER_MISMATCH" }
  );
}

void main().finally(() => prisma.$disconnect());
