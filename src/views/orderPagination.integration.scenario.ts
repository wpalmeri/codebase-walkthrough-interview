import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import {
  OrderPageSchema,
  OrderSchema,
  ValidationErrorResponseSchema,
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
  type OrderPage,
} from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const tenantA = "order-page-tenant-a";
const tenantB = "order-page-tenant-b";
const originalOrderIds = [
  "order-page-a-002",
  "order-page-a-001",
  "order-page-a-003",
  "order-page-a-004",
];

const principals: Record<string, Principal> = {
  "order-page-key-a": {
    tenantId: tenantA,
    subjectId: "order-page-subject-a",
    credentialId: "order-page-credential-a",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
  "order-page-key-b": {
    tenantId: tenantB,
    subjectId: "order-page-subject-b",
    credentialId: "order-page-credential-b",
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
    throw new Error("order pagination server has no TCP address");
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

function orderPage(response: ApiResponse): OrderPage {
  assert.equal(response.status, 200);
  return OrderPageSchema.parse(response.body);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seed(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Order Pagination Tenant A" },
      { id: tenantB, slug: tenantB, name: "Order Pagination Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: "order-page-customer-a", tenantId: tenantA, name: "Order Customer A", email: "a@example.com" },
      { id: "order-page-customer-b", tenantId: tenantB, name: "Order Customer B", email: "b@example.com" },
    ],
  });
  await prisma.order.createMany({
    data: [
      { id: "order-page-a-001", tenantId: tenantA, customerId: "order-page-customer-a", orderDate: new Date("2026-01-02T10:00:00.000Z") },
      { id: "order-page-a-002", tenantId: tenantA, customerId: "order-page-customer-a", orderDate: new Date("2026-01-02T10:00:00.000Z") },
      { id: "order-page-a-003", tenantId: tenantA, customerId: "order-page-customer-a", orderDate: new Date("2026-01-02T09:00:00.000Z") },
      { id: "order-page-a-004", tenantId: tenantA, customerId: "order-page-customer-a", orderDate: new Date("2026-01-02T08:00:00.000Z") },
      { id: "order-page-b-001", tenantId: tenantB, customerId: "order-page-customer-b", orderDate: new Date("2026-01-02T11:00:00.000Z") },
      { id: "order-page-b-002", tenantId: tenantB, customerId: "order-page-customer-b", orderDate: new Date("2026-01-02T07:00:00.000Z") },
    ],
  });
}

async function main(): Promise<void> {
  await seed();
  const indexes = await prisma.$queryRaw<readonly { name: string }[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name = 'Order_tenantId_orderDate_id_idx'
  `;
  assert.deepEqual(indexes, [{ name: "Order_tenantId_orderDate_id_idx" }]);

  const app = createApp({
    principalResolver: { resolve: async (token) => principals[token] ?? null },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const legacy = await request(server, "legacy", "order-page-key-a", "/orders");
    assert.equal(legacy.status, 200);
    // The v1 route introduces deterministic tie-breaking; the legacy route
    // remains the same bare orderDate-only array contract.
    assert.deepEqual(
      OrderSchema.array().parse(legacy.body).map(({ id }) => id).toSorted(),
      originalOrderIds.toSorted()
    );

    const legacyPagination = await request(server, "legacy", "order-page-key-a", "/orders?limit=2");
    assert.equal(legacyPagination.status, 400, "legacy arrays do not silently become pages");

    const oversizedPage = await request(server, "v1", "order-page-key-a", "/orders?limit=101");
    assert.equal(oversizedPage.status, 400, "v1 page limits remain bounded");

    const firstResponse = await request(server, "v1", "order-page-key-a", "/orders?limit=2");
    const firstPage = orderPage(firstResponse);
    assert.deepEqual(firstPage.data.map(({ id }) => id), originalOrderIds.slice(0, 2));
    assert.equal(firstPage.page.limit, 2);
    assert.ok(firstPage.page.nextCursor !== null);
    assert.match(firstResponse.link ?? "", /rel="next"/u);

    // This row sorts before the first cursor boundary. It must not surface in
    // later pages or make the traversal repeat or miss an original row.
    await prisma.order.create({
      data: {
        id: "order-page-a-interleaved",
        tenantId: tenantA,
        customerId: "order-page-customer-a",
        orderDate: new Date("2026-01-02T11:00:00.000Z"),
      },
    });
    const received = firstPage.data.map(({ id }) => id);
    let cursor: string | null = firstPage.page.nextCursor;
    while (cursor !== null) {
      const next = orderPage(
        await request(server, "v1", "order-page-key-a", `/orders?limit=2&cursor=${encodeURIComponent(cursor)}`)
      );
      received.push(...next.data.map(({ id }) => id));
      cursor = next.page.nextCursor;
    }
    assert.deepEqual(received, originalOrderIds, "every original row appears exactly once");

    const malformed = await request(server, "v1", "order-page-key-a", "/orders?cursor=not-an-order-cursor");
    assert.equal(malformed.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(malformed.body).issues, [
      {
        code: "CURSOR_MALFORMED",
        path: "query.cursor",
        message: "Cursor is invalid for this order query",
      },
    ]);

    const wrongFilterCursor = formatPaginationCursor({
      resource: "orders",
      filterFingerprint: fingerprintTenantPaginationBinding({ futureFilter: "unsupported" }, tenantA),
      ordering: ["2026-01-02T10:00:00.000Z", "order-page-a-001"],
    });
    const wrongFilter = await request(
      server,
      "v1",
      "order-page-key-a",
      `/orders?cursor=${encodeURIComponent(wrongFilterCursor)}`
    );
    assert.equal(wrongFilter.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(wrongFilter.body).issues, [
      {
        code: "CURSOR_FILTER_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this order query",
      },
    ]);

    const crossResourceCursor = formatPaginationCursor({
      resource: "payments",
      filterFingerprint: fingerprintTenantPaginationBinding({}, tenantA),
      ordering: ["2026-01-02T10:00:00.000Z", "order-page-a-001"],
    });
    const crossResource = await request(
      server,
      "v1",
      "order-page-key-a",
      `/orders?cursor=${encodeURIComponent(crossResourceCursor)}`
    );
    assert.equal(crossResource.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(crossResource.body).issues, [
      {
        code: "CURSOR_RESOURCE_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this order query",
      },
    ]);

    const tenantBPage = orderPage(await request(server, "v1", "order-page-key-b", "/orders?limit=1"));
    assert.ok(tenantBPage.page.nextCursor !== null);
    const foreignCursor = await request(
      server,
      "v1",
      "order-page-key-a",
      `/orders?limit=1&cursor=${encodeURIComponent(tenantBPage.page.nextCursor ?? "")}`
    );
    assert.equal(foreignCursor.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(foreignCursor.body).issues, [
      {
        code: "CURSOR_FILTER_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this order query",
      },
    ]);
  } finally {
    await close(server);
  }
}

void main().finally(() => prisma.$disconnect());
