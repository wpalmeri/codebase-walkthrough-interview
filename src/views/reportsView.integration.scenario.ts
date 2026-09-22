import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import {
  CustomerRevenueSchema,
  QuarterRevenueSchema,
  ValidationErrorResponseSchema,
} from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const tenantA = "reports-view-tenant-a";
const tenantB = "reports-view-tenant-b";
const principals: Record<string, Principal> = {
  a: {
    tenantId: tenantA,
    subjectId: "reports-view-subject-a",
    credentialId: "reports-view-credential-a",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
  b: {
    tenantId: tenantB,
    subjectId: "reports-view-subject-b",
    credentialId: "reports-view-credential-b",
    kind: "TENANT_API_KEY",
    role: "VIEWER",
  },
};

async function request(
  server: Server,
  version: "legacy" | "v1",
  token: keyof typeof principals,
  path: string
): Promise<{ readonly status: number; readonly body: unknown; readonly requestId: string | null }> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("report server has no TCP address");
  const prefix = version === "v1" ? "/api/v1" : "/api";
  const response = await fetch(`http://127.0.0.1:${address.port}${prefix}${path}`, {
    headers: { authorization: `Bearer ${token}`, "x-request-id": `reports-view-${version}-${token}` },
  });
  return { status: response.status, body: await response.json(), requestId: response.headers.get("x-request-id") };
}

async function seedInvoice(input: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly orderId: string;
  readonly invoiceId: string;
  readonly totalDecimal: string;
}): Promise<void> {
  await prisma.customer.create({
    data: {
      id: input.customerId,
      tenantId: input.tenantId,
      name: `Customer ${input.tenantId}`,
      email: `${input.customerId}@example.com`,
    },
  });
  await prisma.order.create({
    data: { id: input.orderId, tenantId: input.tenantId, customerId: input.customerId, currencyCode: "USD" },
  });
  await prisma.invoice.create({
    data: {
      id: input.invoiceId,
      tenantId: input.tenantId,
      number: `REPORT-VIEW-${input.invoiceId}`,
      customerId: input.customerId,
      orderId: input.orderId,
      status: "POSTED",
      issueDate: new Date("2026-03-31T12:00:00.000Z"),
      dueDate: new Date("2026-04-30T00:00:00.000Z"),
      accountingDate: "2026-03-31",
      total: Number(input.totalDecimal),
      totalDecimal: input.totalDecimal,
      amountPaid: 0,
      amountPaidDecimal: "0.0000",
      currencyCode: "USD",
    },
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function main(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Reports View Tenant A" },
      { id: tenantB, slug: tenantB, name: "Reports View Tenant B" },
    ],
  });
  await seedInvoice({
    tenantId: tenantA,
    customerId: "reports-view-customer-a",
    orderId: "reports-view-order-a",
    invoiceId: "reports-view-invoice-a",
    totalDecimal: "0.1000",
  });
  await seedInvoice({
    tenantId: tenantB,
    customerId: "reports-view-customer-b",
    orderId: "reports-view-order-b",
    invoiceId: "reports-view-invoice-b",
    totalDecimal: "900.0000",
  });
  const app = createApp({ principalResolver: { resolve: async (token) => principals[token] ?? null } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const path = "/reports/revenue-by-quarter?from=2026-01-01&to=2026-03-31";
    const versioned = await request(server, "v1", "a", path);
    const legacy = await request(server, "legacy", "a", path);
    assert.equal(versioned.status, 200);
    assert.equal(legacy.status, 200);
    assert.equal(versioned.requestId, "reports-view-v1-a");
    const quarters = QuarterRevenueSchema.array().parse(versioned.body);
    assert.deepEqual(quarters, [
      { quarter: "2026-Q1", invoiceCount: 1, revenue: 0.1, revenueDecimal: "0.1000" },
    ]);
    assert.deepEqual(legacy.body, versioned.body, "legacy and v1 retain the same report representation");

    const customers = await request(
      server,
      "v1",
      "a",
      "/reports/revenue-by-customer?from=2026-01-01&to=2026-03-31"
    );
    assert.deepEqual(CustomerRevenueSchema.array().parse(customers.body), [
      {
        customerId: "reports-view-customer-a",
        customerName: `Customer ${tenantA}`,
        invoiceCount: 1,
        revenue: 0.1,
        revenueDecimal: "0.1000",
      },
    ]);

    const invalid = await request(
      server,
      "v1",
      "a",
      "/reports/annual-revenue?from=2026-12-31&to=2026-01-01"
    );
    assert.equal(invalid.status, 400);
    assert.equal(ValidationErrorResponseSchema.parse(invalid.body).code, "VALIDATION_ERROR");
  } finally {
    await close(server);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
