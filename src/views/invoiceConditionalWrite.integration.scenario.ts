import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principal: Principal = { subjectId: "invoice-conditional", credentialId: "invoice-conditional", kind: "OPERATOR_API_KEY", role: "BILLING" };

async function main(): Promise<void> {
  try {
    const customer = await prisma.customer.create({ data: { name: "Conditional customer", email: "conditional@example.com" } });
    const order = await prisma.order.create({ data: { id: "conditional-order", customerId: customer.id, status: "INVOICED" } });
    const invoice = await prisma.invoice.create({
      data: { id: "conditional-invoice", number: "CONDITIONAL-1", customerId: customer.id, orderId: order.id, issueDate: new Date("2026-01-01T00:00:00.000Z"), dueDate: new Date("2026-02-01T00:00:00.000Z"), resourceVersion: 1 },
    });
    const app = createApp({ principalResolver: { resolve: async () => principal } });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server has no TCP address");
      const base = `http://127.0.0.1:${address.port}/api/v1/invoices/${invoice.id}`;
      const headers = { authorization: "Bearer operator" };
      const read = await fetch(base, { headers });
      assert.equal(read.status, 200);
      const etag = read.headers.get("etag");
      assert.ok(etag);
      const missing = await fetch(base, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ dueDate: "2026-02-02T00:00:00.000Z" }) });
      assert.equal(missing.status, 428);
      const updated = await fetch(base, { method: "PATCH", headers: { ...headers, "content-type": "application/json", "if-match": etag ?? "" }, body: JSON.stringify({ dueDate: "2026-02-02T00:00:00.000Z" }) });
      assert.equal(updated.status, 200);
      assert.notEqual(updated.headers.get("etag"), etag);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
