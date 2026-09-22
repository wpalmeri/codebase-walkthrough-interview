import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principal: Principal = { subjectId: "rate-conditional", credentialId: "rate-conditional", kind: "OPERATOR_API_KEY", role: "ADMIN" };
async function main(): Promise<void> {
  try {
    const customer = await prisma.customer.create({ data: { name: "Rate conditional customer", email: "rate@example.com" } });
    const product = await prisma.product.create({ data: { sku: "RATE-CONDITIONAL", name: "Rate conditional product", unit: "seat", listPrice: 1, listPriceDecimal: "1.0000", currencyCode: "USD" } });
    const rate = await prisma.rate.create({ data: { customerId: customer.id, productId: product.id, unitPrice: 1, unitPriceDecimal: "1.0000", currencyCode: "USD", resourceVersion: 1 } });
    const app = createApp({ principalResolver: { resolve: async () => principal } }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("server has no TCP address"); const base = `http://127.0.0.1:${address.port}/api/v1/rates/${rate.id}`; const headers = { authorization: "Bearer operator" };
      const read = await fetch(base, { headers }); assert.equal(read.status, 200); const etag = read.headers.get("etag"); assert.ok(etag);
      const updated = await fetch(base, { method: "PATCH", headers: { ...headers, "content-type": "application/json", "if-match": etag ?? "" }, body: JSON.stringify({ unitPrice: "2.5000" }) }); assert.equal(updated.status, 200); assert.notEqual(updated.headers.get("etag"), etag);
      assert.equal((await prisma.rate.findUniqueOrThrow({ where: { id: rate.id } })).unitPriceDecimal?.toFixed(4), "2.5000");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
