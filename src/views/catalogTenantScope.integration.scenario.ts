import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../app";
import { prisma } from "../db";
import type { Principal } from "../auth/principal";

const tenantA = "catalog-tenant-a";
const tenantB = "catalog-tenant-b";

const principals: Record<string, Principal> = {
  "tenant-a-admin": {
    tenantId: tenantA,
    subjectId: "catalog-a-admin",
    credentialId: "catalog-a-admin-key",
    kind: "TENANT_API_KEY",
    role: "ADMIN",
  },
  "tenant-a-viewer": {
    tenantId: tenantA,
    subjectId: "catalog-a-viewer",
    credentialId: "catalog-a-viewer-key",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
  "tenant-b-admin": {
    tenantId: tenantB,
    subjectId: "catalog-b-admin",
    credentialId: "catalog-b-admin-key",
    kind: "TENANT_API_KEY",
    role: "ADMIN",
  },
};

async function request(
  server: Server,
  token: keyof typeof principals,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("catalog test server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  return { status: response.status, body: await response.json() };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seed(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Catalog tenant A" },
      { id: tenantB, slug: tenantB, name: "Catalog tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: "catalog-customer-a", tenantId: tenantA, name: "A customer", email: "a@example.com" },
      { id: "catalog-customer-b", tenantId: tenantB, name: "B customer", email: "b@example.com" },
    ],
  });
  await prisma.product.createMany({
    data: [
      {
        id: "catalog-product-a",
        tenantId: tenantA,
        sku: "CATALOG-A",
        name: "A product",
        unit: "seat",
        listPrice: 10,
        listPriceDecimal: "10.0000",
        currencyCode: "USD",
      },
      {
        id: "catalog-product-b",
        tenantId: tenantB,
        sku: "CATALOG-B",
        name: "B product",
        unit: "seat",
        listPrice: 20,
        listPriceDecimal: "20.0000",
        currencyCode: "USD",
      },
    ],
  });
  await prisma.rate.createMany({
    data: [
      {
        id: "catalog-rate-a",
        customerId: "catalog-customer-a",
        productId: "catalog-product-a",
        unitPrice: 9,
        unitPriceDecimal: "9.0000",
        currencyCode: "USD",
      },
      {
        id: "catalog-rate-b",
        customerId: "catalog-customer-b",
        productId: "catalog-product-b",
        unitPrice: 19,
        unitPriceDecimal: "19.0000",
        currencyCode: "USD",
      },
    ],
  });
  await prisma.comboDiscount.create({
    data: {
      id: "catalog-combo-a",
      tenantId: tenantA,
      customerId: "catalog-customer-a",
      name: "A bundle",
      percentOff: 5,
      percentOffDecimal: "5.0000",
      products: { connect: { id: "catalog-product-a" } },
    },
  });
  await prisma.comboDiscount.create({
    data: {
      id: "catalog-combo-b",
      tenantId: tenantB,
      customerId: "catalog-customer-b",
      name: "B bundle",
      percentOff: 5,
      percentOffDecimal: "5.0000",
      products: { connect: { id: "catalog-product-b" } },
    },
  });
}

function ids(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  return value.map((row) => {
    assert.ok(typeof row === "object" && row !== null && "id" in row);
    assert.equal(typeof row.id, "string");
    return row.id;
  });
}

function responseId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("catalog mutation response did not contain an ID");
  }
  return value.id;
}

function notFound(body: unknown): void {
  assert.deepEqual(body, {
    type: "urn:meridian:problem:not-found",
    title: "Not Found",
    status: 404,
    code: "NOT_FOUND",
  });
}

async function main(): Promise<void> {
  await seed();
  const app = createApp({
    principalResolver: {
      resolve: async (token) => principals[token] ?? null,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const customers = await request(server, "tenant-a-viewer", "/customers");
    const products = await request(server, "tenant-a-viewer", "/products");
    const rates = await request(server, "tenant-a-viewer", "/rates?customerId=catalog-customer-a");
    const combos = await request(server, "tenant-a-viewer", "/rates/combos");
    assert.equal(customers.status, 200);
    assert.deepEqual(ids(customers.body), ["catalog-customer-a"]);
    assert.equal(products.status, 200);
    assert.deepEqual(ids(products.body), ["catalog-product-a"]);
    assert.equal(rates.status, 200);
    assert.deepEqual(ids(rates.body), ["catalog-rate-a"]);
    assert.equal(combos.status, 200);
    assert.deepEqual(ids(combos.body), ["catalog-combo-a"]);

    const foreignRateList = await request(
      server,
      "tenant-a-viewer",
      "/rates?customerId=catalog-customer-b"
    );
    const missingRateList = await request(server, "tenant-a-viewer", "/rates?customerId=missing-customer");
    assert.equal(foreignRateList.status, 404);
    assert.deepEqual(foreignRateList.body, missingRateList.body);
    notFound(foreignRateList.body);

    const comboCount = await prisma.comboDiscount.count();
    const viewerWrite = await request(server, "tenant-a-viewer", "/rates/combos", {
      method: "POST",
      body: JSON.stringify({
        name: "Viewer bundle",
        productIds: ["catalog-product-a"],
        percentOff: "5.0000",
      }),
    });
    assert.equal(viewerWrite.status, 403);
    assert.equal(await prisma.comboDiscount.count(), comboCount);

    const foreignProductWrite = await request(server, "tenant-a-admin", "/rates/combos", {
      method: "POST",
      body: JSON.stringify({
        name: "Foreign product bundle",
        productIds: ["catalog-product-b"],
        percentOff: "5.0000",
      }),
    });
    const missingProductWrite = await request(server, "tenant-a-admin", "/rates/combos", {
      method: "POST",
      body: JSON.stringify({
        name: "Missing product bundle",
        productIds: ["missing-product"],
        percentOff: "5.0000",
      }),
    });
    assert.equal(foreignProductWrite.status, 404);
    assert.deepEqual(foreignProductWrite.body, missingProductWrite.body);
    assert.equal(await prisma.comboDiscount.count(), comboCount);

    const foreignCustomerWrite = await request(server, "tenant-a-admin", "/rates/combos", {
      method: "POST",
      body: JSON.stringify({
        name: "Foreign customer bundle",
        customerId: "catalog-customer-b",
        productIds: ["catalog-product-a"],
        percentOff: "5.0000",
      }),
    });
    const missingCustomerWrite = await request(server, "tenant-a-admin", "/rates/combos", {
      method: "POST",
      body: JSON.stringify({
        name: "Missing customer bundle",
        customerId: "missing-customer",
        productIds: ["catalog-product-a"],
        percentOff: "5.0000",
      }),
    });
    assert.equal(foreignCustomerWrite.status, 404);
    assert.deepEqual(foreignCustomerWrite.body, missingCustomerWrite.body);
    assert.equal(await prisma.comboDiscount.count(), comboCount);

    const created = await request(server, "tenant-a-admin", "/rates/combos", {
      method: "POST",
      body: JSON.stringify({
        name: "Tenant A bundle",
        customerId: "catalog-customer-a",
        productIds: ["catalog-product-a"],
        percentOff: "7.5000",
      }),
    });
    assert.equal(created.status, 200);
    const createdId = responseId(created.body);
    assert.equal((await prisma.comboDiscount.findUniqueOrThrow({ where: { id: createdId } })).tenantId, tenantA);

    const beforeForeignRate = await prisma.rate.findUniqueOrThrow({ where: { id: "catalog-rate-b" } });
    const foreignRateWrite = await request(server, "tenant-a-admin", "/rates/catalog-rate-b", {
      method: "PUT",
      body: JSON.stringify({ unitPrice: "1.0000" }),
    });
    const missingRateWrite = await request(server, "tenant-a-admin", "/rates/missing-rate", {
      method: "PUT",
      body: JSON.stringify({ unitPrice: "1.0000" }),
    });
    assert.equal(foreignRateWrite.status, 404);
    assert.deepEqual(foreignRateWrite.body, missingRateWrite.body);
    assert.equal((await prisma.rate.findUniqueOrThrow({ where: { id: "catalog-rate-b" } })).unitPrice, beforeForeignRate.unitPrice);
  } finally {
    await close(server);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
