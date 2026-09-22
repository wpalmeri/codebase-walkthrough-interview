import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import {
  InvoicePageSchema,
  InvoiceSchema,
  ValidationErrorResponseSchema,
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
  type InvoicePage,
} from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const tenantA = "invoice-page-tenant-a";
const tenantB = "invoice-page-tenant-b";
const originalInvoiceIds = ["invoice-page-a-002", "invoice-page-a-001", "invoice-page-a-003", "invoice-page-a-004"];
const principals: Record<string, Principal> = {
  "invoice-page-key-a": { tenantId: tenantA, subjectId: "invoice-page-subject-a", credentialId: "invoice-page-credential-a", kind: "TENANT_API_KEY", role: "VIEWER" },
  "invoice-page-key-b": { tenantId: tenantB, subjectId: "invoice-page-subject-b", credentialId: "invoice-page-credential-b", kind: "TENANT_API_KEY", role: "VIEWER" },
};

type ApiResponse = { readonly status: number; readonly body: unknown; readonly link: string | null };

async function request(server: Server, version: "legacy" | "v1", token: keyof typeof principals, path: string): Promise<ApiResponse> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invoice pagination server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}${version === "v1" ? "/api/v1" : "/api"}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json(), link: response.headers.get("link") };
}

function invoicePage(response: ApiResponse): InvoicePage {
  assert.equal(response.status, 200);
  return InvoicePageSchema.parse(response.body);
}

async function createInvoice(tenantId: string, customerId: string, suffix: string, issueDate: string): Promise<void> {
  const orderId = `order-${suffix}`;
  await prisma.order.create({ data: { id: orderId, tenantId, customerId, orderDate: new Date(issueDate) } });
  await prisma.invoice.create({
    data: { id: `invoice-${suffix}`, tenantId, number: `INV-${suffix}`, customerId, orderId, issueDate: new Date(issueDate), dueDate: new Date("2026-02-01T00:00:00.000Z") },
  });
}

async function seed(): Promise<void> {
  await prisma.tenant.createMany({ data: [
    { id: tenantA, slug: tenantA, name: "Invoice Page Tenant A" },
    { id: tenantB, slug: tenantB, name: "Invoice Page Tenant B" },
  ] });
  await prisma.customer.createMany({ data: [
    { id: "invoice-page-customer-a", tenantId: tenantA, name: "Invoice Customer A", email: "a@example.com" },
    { id: "invoice-page-customer-b", tenantId: tenantB, name: "Invoice Customer B", email: "b@example.com" },
  ] });
  for (const [tenantId, customerId, suffix, issueDate] of [
    [tenantA, "invoice-page-customer-a", "page-a-001", "2026-01-02T10:00:00.000Z"],
    [tenantA, "invoice-page-customer-a", "page-a-002", "2026-01-02T10:00:00.000Z"],
    [tenantA, "invoice-page-customer-a", "page-a-003", "2026-01-02T09:00:00.000Z"],
    [tenantA, "invoice-page-customer-a", "page-a-004", "2026-01-02T08:00:00.000Z"],
    [tenantB, "invoice-page-customer-b", "page-b-001", "2026-01-02T11:00:00.000Z"],
    [tenantB, "invoice-page-customer-b", "page-b-002", "2026-01-02T07:00:00.000Z"],
  ] as const) await createInvoice(tenantId, customerId, suffix, issueDate);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function main(): Promise<void> {
  await seed();
  const app = createApp({ principalResolver: { resolve: async (token) => principals[token] ?? null } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const legacy = await request(server, "legacy", "invoice-page-key-a", "/invoices");
    assert.equal(legacy.status, 200);
    assert.deepEqual(InvoiceSchema.array().parse(legacy.body).map(({ id }) => id).toSorted(), originalInvoiceIds.toSorted());
    assert.equal((await request(server, "legacy", "invoice-page-key-a", "/invoices?limit=2")).status, 400);
    assert.equal((await request(server, "v1", "invoice-page-key-a", "/invoices?limit=101")).status, 400);

    const firstResponse = await request(server, "v1", "invoice-page-key-a", "/invoices?limit=2");
    const first = invoicePage(firstResponse);
    assert.deepEqual(first.data.map(({ id }) => id), originalInvoiceIds.slice(0, 2));
    assert.equal(first.page.limit, 2);
    assert.ok(first.page.nextCursor !== null);
    assert.match(firstResponse.link ?? "", /rel="next"/u);
    assert.deepEqual(first.data[0], {
      id: "invoice-page-a-002", number: "INV-page-a-002", customerId: "invoice-page-customer-a",
      customerName: "Invoice Customer A", customerEmail: "a@example.com", billingAddress: null,
      orderId: "order-page-a-002", orderReference: null, status: "DRAFT",
      issueDate: "2026-01-02T10:00:00.000Z", dueDate: "2026-02-01T00:00:00.000Z",
      total: 0, amountPaid: 0, totalDecimal: "0.0000", amountPaidDecimal: "0.0000",
      balance: 0, balanceDecimal: "0.0000", postedAt: null, lines: [], payments: [], transmissions: [], lastTransmission: null,
    });

    await createInvoice(tenantA, "invoice-page-customer-a", "page-a-interleaved", "2026-01-02T11:00:00.000Z");
    const received = first.data.map(({ id }) => id);
    let cursor: string | null = first.page.nextCursor;
    while (cursor !== null) {
      const next = invoicePage(await request(server, "v1", "invoice-page-key-a", `/invoices?limit=2&cursor=${encodeURIComponent(cursor)}`));
      received.push(...next.data.map(({ id }) => id));
      cursor = next.page.nextCursor;
    }
    assert.deepEqual(received, originalInvoiceIds, "every original row appears exactly once");

    const expectedValidation = async (path: string, code: string) => {
      const response = await request(server, "v1", "invoice-page-key-a", path);
      assert.equal(response.status, 400);
      assert.deepEqual(ValidationErrorResponseSchema.parse(response.body).issues, [{ code, path: "query.cursor", message: "Cursor is invalid for this invoice query" }]);
    };
    await expectedValidation("/invoices?cursor=not-an-invoice-cursor", "CURSOR_MALFORMED");
    const filterCursor = formatPaginationCursor({ resource: "invoices", filterFingerprint: fingerprintTenantPaginationBinding({ futureFilter: "unsupported" }, tenantA), ordering: ["2026-01-02T10:00:00.000Z", "invoice-page-a-001"] });
    await expectedValidation(`/invoices?cursor=${encodeURIComponent(filterCursor)}`, "CURSOR_FILTER_MISMATCH");
    const resourceCursor = formatPaginationCursor({ resource: "payments", filterFingerprint: fingerprintTenantPaginationBinding({}, tenantA), ordering: ["2026-01-02T10:00:00.000Z", "invoice-page-a-001"] });
    await expectedValidation(`/invoices?cursor=${encodeURIComponent(resourceCursor)}`, "CURSOR_RESOURCE_MISMATCH");
    const tenantBPage = invoicePage(await request(server, "v1", "invoice-page-key-b", "/invoices?limit=1"));
    await expectedValidation(`/invoices?limit=1&cursor=${encodeURIComponent(tenantBPage.page.nextCursor ?? "")}`, "CURSOR_FILTER_MISMATCH");
  } finally {
    await close(server);
  }
}

void main().finally(() => prisma.$disconnect());
