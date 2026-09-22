import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import {
  CustomerPageSchema,
  CustomerSchema,
  ProductPageSchema,
  ProductSchema,
  ValidationErrorResponseSchema,
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
  type CustomerPage,
  type ProductPage,
} from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const tenantA = "catalog-page-tenant-a";
const tenantB = "catalog-page-tenant-b";
const originalCustomerIds = [
  "catalog-customer-a-001",
  "catalog-customer-a-002",
  "catalog-customer-a-003",
  "catalog-customer-a-004",
];
const originalProductIds = [
  "catalog-product-a-001",
  "catalog-product-a-002",
  "catalog-product-a-003",
  "catalog-product-a-004",
];

const principals: Record<string, Principal> = {
  "catalog-page-key-a": {
    tenantId: tenantA,
    subjectId: "catalog-page-subject-a",
    credentialId: "catalog-page-credential-a",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
  "catalog-page-key-b": {
    tenantId: tenantB,
    subjectId: "catalog-page-subject-b",
    credentialId: "catalog-page-credential-b",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
};

type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly link: string | null;
};

async function request(
  server: Server,
  version: "legacy" | "v1",
  token: keyof typeof principals,
  path: string
): Promise<ApiResponse> {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("catalog pagination server has no TCP address");
  }
  const prefix = version === "v1" ? "/api/v1" : "/api";
  const response = await fetch(`http://127.0.0.1:${address.port}${prefix}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: await response.json(),
    link: response.headers.get("link"),
  };
}

function customerPage(response: ApiResponse): CustomerPage {
  assert.equal(response.status, 200);
  return CustomerPageSchema.parse(response.body);
}

function productPage(response: ApiResponse): ProductPage {
  assert.equal(response.status, 200);
  return ProductPageSchema.parse(response.body);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seed(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Catalog Pagination Tenant A" },
      { id: tenantB, slug: tenantB, name: "Catalog Pagination Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: originalCustomerIds[0], tenantId: tenantA, name: "Alpha", email: "customer-001@example.com" },
      { id: originalCustomerIds[1], tenantId: tenantA, name: "Alpha", email: "customer-002@example.com" },
      { id: originalCustomerIds[2], tenantId: tenantA, name: "Bravo", email: "customer-003@example.com" },
      { id: originalCustomerIds[3], tenantId: tenantA, name: "Charlie", email: "customer-004@example.com" },
      { id: "catalog-customer-b-001", tenantId: tenantB, name: "Tenant B Customer A", email: "customer-b-001@example.com" },
      { id: "catalog-customer-b-002", tenantId: tenantB, name: "Tenant B Customer B", email: "customer-b-002@example.com" },
    ],
  });
  await prisma.product.createMany({
    data: [
      ...originalProductIds.map((id, index) => ({
        id,
        tenantId: tenantA,
        sku: `CATALOG-${String(index + 1).padStart(3, "0")}`,
        name: `Catalog Product ${index + 1}`,
        unit: "seat",
        listPrice: index + 1,
      })),
      {
        id: "catalog-product-b-001",
        tenantId: tenantB,
        sku: "TENANT-B-CATALOG-001",
        name: "Tenant B Catalog Product A",
        unit: "seat",
        listPrice: 10,
      },
      {
        id: "catalog-product-b-002",
        tenantId: tenantB,
        sku: "TENANT-B-CATALOG-002",
        name: "Tenant B Catalog Product B",
        unit: "seat",
        listPrice: 20,
      },
    ],
  });
}

async function main(): Promise<void> {
  await seed();
  const indexes = await prisma.$queryRaw<readonly { name: string }[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
      AND name IN ('Customer_tenantId_name_id_idx', 'Product_tenantId_sku_id_idx')
    ORDER BY name
  `;
  assert.deepEqual(indexes, [
    { name: "Customer_tenantId_name_id_idx" },
    { name: "Product_tenantId_sku_id_idx" },
  ]);

  const app = createApp({
    principalResolver: { resolve: async (token) => principals[token] ?? null },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const legacyCustomers = await request(server, "legacy", "catalog-page-key-a", "/customers");
    assert.equal(legacyCustomers.status, 200);
    assert.deepEqual(CustomerSchema.array().parse(legacyCustomers.body).map(({ id }) => id), originalCustomerIds);

    const legacyProducts = await request(server, "legacy", "catalog-page-key-a", "/products");
    assert.equal(legacyProducts.status, 200);
    assert.deepEqual(ProductSchema.array().parse(legacyProducts.body).map(({ id }) => id), originalProductIds);

    const legacyPagination = await request(server, "legacy", "catalog-page-key-a", "/customers?limit=2");
    assert.equal(legacyPagination.status, 400, "legacy arrays do not silently become pages");

    const oversizedPage = await request(server, "v1", "catalog-page-key-a", "/customers?limit=101");
    assert.equal(oversizedPage.status, 400, "v1 page limits remain bounded");

    const firstCustomersResponse = await request(server, "v1", "catalog-page-key-a", "/customers?limit=2");
    const firstCustomers = customerPage(firstCustomersResponse);
    assert.deepEqual(firstCustomers.data.map(({ id }) => id), originalCustomerIds.slice(0, 2));
    assert.equal(firstCustomers.page.limit, 2);
    assert.ok(firstCustomers.page.nextCursor !== null);
    assert.match(firstCustomersResponse.link ?? "", /rel="next"/u);

    // The new tied name sorts before the first cursor boundary. It must never
    // appear later or cause a duplicate/missed row in the original traversal.
    await prisma.customer.create({
      data: {
        id: "catalog-customer-a-000-interleaved",
        tenantId: tenantA,
        name: "Alpha",
        email: "customer-interleaved@example.com",
      },
    });
    const receivedCustomers = firstCustomers.data.map(({ id }) => id);
    let customerCursor: string | null = firstCustomers.page.nextCursor;
    while (customerCursor !== null) {
      const next = customerPage(
        await request(
          server,
          "v1",
          "catalog-page-key-a",
          `/customers?limit=2&cursor=${encodeURIComponent(customerCursor)}`
        )
      );
      receivedCustomers.push(...next.data.map(({ id }) => id));
      customerCursor = next.page.nextCursor;
    }
    assert.deepEqual(receivedCustomers, originalCustomerIds);

    const firstProductsResponse = await request(server, "v1", "catalog-page-key-a", "/products?limit=2");
    const firstProducts = productPage(firstProductsResponse);
    assert.deepEqual(firstProducts.data.map(({ id }) => id), originalProductIds.slice(0, 2));
    assert.ok(firstProducts.page.nextCursor !== null);
    assert.match(firstProductsResponse.link ?? "", /rel="next"/u);
    await prisma.product.create({
      data: {
        id: "catalog-product-a-000-interleaved",
        tenantId: tenantA,
        sku: "CATALOG-000",
        name: "Interleaved Catalog Product",
        unit: "seat",
        listPrice: 0,
      },
    });
    const receivedProducts = firstProducts.data.map(({ id }) => id);
    let productCursor: string | null = firstProducts.page.nextCursor;
    while (productCursor !== null) {
      const next = productPage(
        await request(
          server,
          "v1",
          "catalog-page-key-a",
          `/products?limit=2&cursor=${encodeURIComponent(productCursor)}`
        )
      );
      receivedProducts.push(...next.data.map(({ id }) => id));
      productCursor = next.page.nextCursor;
    }
    assert.deepEqual(receivedProducts, originalProductIds);

    const malformed = await request(
      server,
      "v1",
      "catalog-page-key-a",
      "/customers?cursor=not-a-catalog-cursor"
    );
    assert.equal(malformed.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(malformed.body).issues, [
      {
        code: "CURSOR_MALFORMED",
        path: "query.cursor",
        message: "Cursor is invalid for this customer query",
      },
    ]);

    const wrongFilterCursor = formatPaginationCursor({
      resource: "customers",
      filterFingerprint: fingerprintTenantPaginationBinding(
        { futureFilter: "not-supported" },
        tenantA
      ),
      ordering: ["Alpha", originalCustomerIds[1]],
    });
    const wrongFilter = await request(
      server,
      "v1",
      "catalog-page-key-a",
      `/customers?cursor=${encodeURIComponent(wrongFilterCursor)}`
    );
    assert.equal(wrongFilter.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(wrongFilter.body).issues, [
      {
        code: "CURSOR_FILTER_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this customer query",
      },
    ]);

    const crossResource = await request(
      server,
      "v1",
      "catalog-page-key-a",
      `/customers?cursor=${encodeURIComponent(firstProducts.page.nextCursor ?? "")}`
    );
    assert.equal(crossResource.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(crossResource.body).issues, [
      {
        code: "CURSOR_RESOURCE_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this customer query",
      },
    ]);

    const tenantBCustomers = customerPage(
      await request(server, "v1", "catalog-page-key-b", "/customers?limit=1")
    );
    assert.ok(tenantBCustomers.page.nextCursor !== null);
    const foreignCustomerCursor = await request(
      server,
      "v1",
      "catalog-page-key-a",
      `/customers?limit=1&cursor=${encodeURIComponent(tenantBCustomers.page.nextCursor ?? "")}`
    );
    assert.equal(foreignCustomerCursor.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(foreignCustomerCursor.body).issues, [
      {
        code: "CURSOR_FILTER_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this customer query",
      },
    ]);

    const tenantBProducts = productPage(
      await request(server, "v1", "catalog-page-key-b", "/products?limit=1")
    );
    assert.ok(tenantBProducts.page.nextCursor !== null);
    const foreignProductCursor = await request(
      server,
      "v1",
      "catalog-page-key-a",
      `/products?limit=1&cursor=${encodeURIComponent(tenantBProducts.page.nextCursor ?? "")}`
    );
    assert.equal(foreignProductCursor.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(foreignProductCursor.body).issues, [
      {
        code: "CURSOR_FILTER_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this product query",
      },
    ]);
  } finally {
    await close(server);
  }
}

void main().finally(() => prisma.$disconnect());
