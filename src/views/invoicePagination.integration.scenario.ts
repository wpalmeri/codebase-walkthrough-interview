import assert from "node:assert/strict";
import { once } from "node:events";
import { InvoicePageSchema } from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principal: Principal = { subjectId: "invoice-page", credentialId: "invoice-page", kind: "OPERATOR_API_KEY", role: "VIEWER" };
async function main(): Promise<void> {
  try {
    const customers = await Promise.all(["a", "b", "c"].map((id) => prisma.customer.create({ data: { id: `invoice-page-${id}`, name: id, email: `${id}@example.com` } })));
    await Promise.all(customers.map((customer, index) => prisma.order.create({ data: { id: `invoice-page-order-${index}`, customerId: customer.id } })));
    await Promise.all(customers.map((customer, index) => prisma.invoice.create({ data: { id: `invoice-page-${index}`, number: `INVOICE-PAGE-${index}`, customerId: customer.id, orderId: `invoice-page-order-${index}`, issueDate: new Date(`2026-01-0${3 - index}T00:00:00.000Z`), dueDate: new Date("2026-02-01T00:00:00.000Z") } })));
    const app = createApp({ principalResolver: { resolve: async () => principal } }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("server has no TCP address");
      const base = `http://127.0.0.1:${address.port}/api/v1/invoices?limit=2`;
      const firstResponse = await fetch(base, { headers: { authorization: "Bearer operator" } }); assert.equal(firstResponse.status, 200);
      const first = InvoicePageSchema.parse(await firstResponse.json()); assert.equal(first.data.length, 2); assert.ok(first.page.nextCursor); assert.match(firstResponse.headers.get("link") ?? "", /rel="next"/u);
      const secondResponse = await fetch(`${base}&cursor=${encodeURIComponent(first.page.nextCursor ?? "")}`, { headers: { authorization: "Bearer operator" } });
      const second = InvoicePageSchema.parse(await secondResponse.json()); assert.equal(second.data.length, 1); assert.equal(second.page.nextCursor, null);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
