import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { CustomerPageSchema, ProductPageSchema } from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principals: Record<string, Principal> = {
  admin: { subjectId: "catalog-admin", credentialId: "catalog-admin-key", kind: "OPERATOR_API_KEY", role: "ADMIN" },
  viewer: { subjectId: "catalog-viewer", credentialId: "catalog-viewer-key", kind: "OPERATOR_API_KEY", role: "VIEWER" },
};

async function request(server: Server, token: keyof typeof principals, path: string, init: RequestInit = {}) {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, { ...init, headers });
  return { response, body: await response.json() };
}

function ids(body: unknown): string[] {
  assert.ok(Array.isArray(body));
  return body.map((row) => {
    assert.ok(typeof row === "object" && row !== null && "id" in row);
    assert.equal(typeof row.id, "string");
    return row.id;
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function main(): Promise<void> {
  try {
    await prisma.customer.createMany({
      data: [
        { id: "catalog-customer-a", name: "A customer", email: "a@example.com" },
        { id: "catalog-customer-b", name: "B customer", email: "b@example.com" },
      ],
    });
    await prisma.product.createMany({
      data: [
        { id: "catalog-product-a", sku: "CATALOG-A", name: "A product", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" },
        { id: "catalog-product-b", sku: "CATALOG-B", name: "B product", unit: "seat", listPrice: 20, listPriceDecimal: "20.0000", currencyCode: "USD" },
      ],
    });
    await prisma.rate.create({
      data: { id: "catalog-rate-a", customerId: "catalog-customer-a", productId: "catalog-product-a", unitPrice: 9, unitPriceDecimal: "9.0000", currencyCode: "USD" },
    });

    const app = createApp({ environment: "production", principalResolver: { resolve: async (token) => principals[token] ?? null } });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const customers = await request(server, "viewer", "/customers");
      const products = await request(server, "viewer", "/products");
      assert.deepEqual(ids(CustomerPageSchema.parse(customers.body).data).toSorted(), ["catalog-customer-a", "catalog-customer-b"]);
      assert.deepEqual(ids(ProductPageSchema.parse(products.body).data).toSorted(), ["catalog-product-a", "catalog-product-b"]);

      const customerRates = await request(server, "viewer", "/rates?customerId=catalog-customer-a");
      assert.equal(customerRates.response.status, 200);
      assert.deepEqual(ids(customerRates.body), ["catalog-rate-a"]);
      const noRates = await request(server, "viewer", "/rates?customerId=catalog-customer-b");
      assert.equal(noRates.response.status, 200);
      assert.deepEqual(ids(noRates.body), []);

      const beforeDiscounts = await prisma.comboDiscount.count();
      const denied = await request(server, "viewer", "/rates/combos", {
        method: "POST",
        body: JSON.stringify({ name: "Viewer bundle", productIds: ["catalog-product-a"], percentOff: "5.0000" }),
      });
      assert.equal(denied.response.status, 403);
      assert.equal(await prisma.comboDiscount.count(), beforeDiscounts);

      const created = await request(server, "admin", "/rates/combos", {
        method: "POST",
        body: JSON.stringify({ name: "Customer A bundle", customerId: "catalog-customer-a", productIds: ["catalog-product-a"], percentOff: "5.0000" }),
      });
      assert.equal(created.response.status, 200);
      const customerACombos = await request(server, "viewer", "/rates/combos?customerId=catalog-customer-a");
      assert.equal(customerACombos.response.status, 200);
      assert.equal(ids(customerACombos.body).length, 1);
      const customerBCombos = await request(server, "viewer", "/rates/combos?customerId=catalog-customer-b");
      assert.deepEqual(ids(customerBCombos.body), []);
    } finally {
      await close(server);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
