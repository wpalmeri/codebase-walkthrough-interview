import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import {
  PaymentPageSchema,
  ValidationErrorResponseSchema,
  type PaymentPage,
} from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const tenantA = "payment-page-tenant-a";
const tenantB = "payment-page-tenant-b";
const customerA = "payment-page-customer-a";
const customerB = "payment-page-customer-b";
const tiedReceivedAt = new Date("2026-09-22T12:00:00.000Z");
const originalPaymentIds = Array.from({ length: 102 }, (_, index) =>
  `payment-page-a-${String(index + 1).padStart(3, "0")}`
);

const principals: Record<string, Principal> = {
  "payment-page-key-a": {
    tenantId: tenantA,
    subjectId: "payment-page-subject-a",
    credentialId: "payment-page-credential-a",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
  "payment-page-key-b": {
    tenantId: tenantB,
    subjectId: "payment-page-subject-b",
    credentialId: "payment-page-credential-b",
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
    throw new Error("payment pagination server has no TCP address");
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

function page(response: ApiResponse): PaymentPage {
  assert.equal(response.status, 200);
  return PaymentPageSchema.parse(response.body);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seed(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Payment Pagination Tenant A" },
      { id: tenantB, slug: tenantB, name: "Payment Pagination Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: customerA, tenantId: tenantA, name: "Payment Pagination Customer A", email: "page-a@example.com" },
      { id: customerB, tenantId: tenantB, name: "Payment Pagination Customer B", email: "page-b@example.com" },
    ],
  });
  await prisma.payment.createMany({
    data: [
      ...originalPaymentIds.map((id) => ({
        id,
        tenantId: tenantA,
        customerId: customerA,
        amount: 1,
        amountDecimal: "1.0000",
        currencyCode: "USD",
        receivedAt: tiedReceivedAt,
      })),
      {
        id: "payment-page-b-001",
        tenantId: tenantB,
        customerId: customerB,
        amount: 2,
        amountDecimal: "2.0000",
        currencyCode: "USD",
        receivedAt: tiedReceivedAt,
      },
      {
        id: "payment-page-b-002",
        tenantId: tenantB,
        customerId: customerB,
        amount: 3,
        amountDecimal: "3.0000",
        currencyCode: "USD",
        receivedAt: tiedReceivedAt,
      },
    ],
  });
}

async function main(): Promise<void> {
  await seed();
  const paginationIndexes = await prisma.$queryRaw<readonly { name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'Payment_tenantId_receivedAt_id_idx'
  `;
  assert.equal(paginationIndexes.length, 1, "payment keyset index must be installed by migration");
  const app = createApp({
    principalResolver: { resolve: async (token) => principals[token] ?? null },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const customerAQuery = `/payments?customerId=${customerA}`;
    const legacy = await request(server, "legacy", "payment-page-key-a", "/payments");
    assert.equal(legacy.status, 200);
    const legacyRows = legacy.body;
    assert.ok(Array.isArray(legacyRows));
    assert.equal(legacyRows.length, 100, "legacy remains the first-100 array contract");

    const first = await request(server, "v1", "payment-page-key-a", customerAQuery);
    const firstPage = page(first);
    assert.equal(firstPage.page.limit, 50, "v1 defaults to 50 rows");
    assert.equal(firstPage.data.length, 50);
    assert.ok(firstPage.page.nextCursor !== null);
    assert.match(first.link ?? "", /rel="next"/u);
    assert.match(first.link ?? "", /cursor=pc1_/u);

    // This new payment sorts before the page boundary. Keyset paging must not
    // duplicate it or displace an older row still reachable after that cursor.
    await prisma.payment.create({
      data: {
        id: "payment-page-a-interleaved-newer",
        tenantId: tenantA,
        customerId: customerA,
        amount: 4,
        amountDecimal: "4.0000",
        currencyCode: "USD",
        receivedAt: new Date("2026-09-22T12:00:01.000Z"),
      },
    });

    const received = firstPage.data.map(({ id }) => id);
    let cursor: string | null = firstPage.page.nextCursor;
    while (cursor !== null) {
      const nextResponse = await request(
        server,
        "v1",
        "payment-page-key-a",
        `${customerAQuery}&cursor=${encodeURIComponent(cursor)}`
      );
      const next = page(nextResponse);
      received.push(...next.data.map(({ id }) => id));
      cursor = next.page.nextCursor;
      if (cursor === null) assert.equal(nextResponse.link, null, "the final page omits Link");
    }
    assert.equal(received.length, originalPaymentIds.length);
    assert.equal(new Set(received).size, originalPaymentIds.length, "tied rows are not duplicated");
    assert.deepEqual(new Set(received), new Set(originalPaymentIds));
    assert.equal(received.includes("payment-page-a-interleaved-newer"), false);

    const malformed = await request(
      server,
      "v1",
      "payment-page-key-a",
      `${customerAQuery}&cursor=not-a-payment-cursor`
    );
    assert.equal(malformed.status, 400);
    const malformedBody = ValidationErrorResponseSchema.parse(malformed.body);
    assert.deepEqual(malformedBody.issues, [
      {
        code: "CURSOR_MALFORMED",
        path: "query.cursor",
        message: "Cursor is invalid for this payment query",
      },
    ]);

    const wrongFilter = await request(
      server,
      "v1",
      "payment-page-key-a",
      `/payments?cursor=${encodeURIComponent(firstPage.page.nextCursor ?? "")}`
    );
    assert.equal(wrongFilter.status, 400);
    assert.deepEqual(ValidationErrorResponseSchema.parse(wrongFilter.body).issues, [
      {
        code: "CURSOR_FILTER_MISMATCH",
        path: "query.cursor",
        message: "Cursor is invalid for this payment query",
      },
    ]);

    const tenantB = page(
      await request(server, "v1", "payment-page-key-b", `/payments?customerId=${customerB}&limit=1`)
    );
    assert.equal(tenantB.data.length, 1);
    assert.ok(tenantB.page.nextCursor !== null);
    const foreignCursor = page(
      await request(
        server,
        "v1",
        "payment-page-key-a",
        `/payments?customerId=${customerB}&cursor=${encodeURIComponent(tenantB.page.nextCursor)}`
      )
    );
    assert.deepEqual(foreignCursor.data, [], "a valid foreign cursor cannot bypass tenant scope");
  } finally {
    await close(server);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
