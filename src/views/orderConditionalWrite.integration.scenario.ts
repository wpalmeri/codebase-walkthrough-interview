import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";
import { formatResourceEtag } from "../http/resourceVersion";
import * as orders from "../controllers/orderController";

const principal: Principal = { subjectId: "order-conditional", credentialId: "order-conditional", kind: "OPERATOR_API_KEY", role: "BILLING" };
const audit = { principal: { kind: "OPERATOR_API_KEY" as const, subjectId: "order-conditional", credentialId: "order-conditional" }, requestId: "order-conditional-seed" };
async function main(): Promise<void> {
  try {
    const customer = await prisma.customer.create({ data: { name: "Order conditional customer", email: "order-conditional@example.com" } });
    const product = await prisma.product.create({ data: { sku: "ORDER-CONDITIONAL", name: "Order conditional product", unit: "seat", listPrice: 1, listPriceDecimal: "1.0000", currencyCode: "USD" } });
    const order = await orders.createOrder({ customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] }, audit);
    const app = createApp({ principalResolver: { resolve: async () => principal } }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("server has no TCP address");
      const base = `http://127.0.0.1:${address.port}/api/v1/orders/${order.id}`; const headers = { authorization: "Bearer operator" };
      const read = await fetch(base, { headers }); assert.equal(read.status, 200); const etag = read.headers.get("etag"); assert.ok(etag);
      const stale = await fetch(base, { method: "PATCH", headers: { ...headers, "content-type": "application/json", "if-match": formatResourceEtag({ kind: "order", id: "wrong-order", version: 1 }) }, body: JSON.stringify({ notes: "no" }) }); assert.equal(stale.status, 412);
      const updated = await fetch(base, { method: "PATCH", headers: { ...headers, "content-type": "application/json", "if-match": etag ?? "" }, body: JSON.stringify({ notes: "updated" }) }); assert.equal(updated.status, 200);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
