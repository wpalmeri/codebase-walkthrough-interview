import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const tenant = "invoice-conditional";
const otherTenant = "invoice-conditional-other";
const principal: Principal = {
  tenantId: tenant,
  subjectId: "invoice-admin",
  credentialId: "invoice-key",
  kind: "TENANT_API_KEY",
  role: "BILLING",
};
const otherPrincipal: Principal = { ...principal, tenantId: otherTenant, credentialId: "invoice-other-key" };
const migration = join(process.cwd(), "prisma/migrations/20260922160000_invoice_conditional_writes/migration.sql");
const problemCode = (body: unknown) => z.object({ code: z.string() }).passthrough().parse(body).code;

async function main(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenant, slug: tenant, name: tenant },
      { id: otherTenant, slug: otherTenant, name: otherTenant },
    ],
  });
  const customer = await prisma.customer.create({
    data: { tenantId: tenant, name: "Customer", email: "customer@example.com" },
  });
  const order = await prisma.order.create({
    data: { tenantId: tenant, customerId: customer.id, status: "INVOICED" },
  });
  // This row predates the migration: null remains logical version zero until
  // a successful v1 write adopts it, rather than requiring a deployment scan.
  const invoice = await prisma.invoice.create({
    data: {
      tenantId: tenant,
      number: "INV-CONDITIONAL",
      customerId: customer.id,
      orderId: order.id,
      dueDate: new Date("2030-01-01"),
      total: 10,
      totalDecimal: "10.0000",
      currencyCode: "USD",
      customerNameSnapshot: customer.name,
      customerEmailSnapshot: customer.email,
    },
  });
  assert.equal(invoice.resourceVersion, null);
  execFileSync(
    join(process.cwd(), "node_modules/.bin/prisma"),
    ["db", "execute", "--url", process.env.DATABASE_URL ?? "", "--file", migration],
    { stdio: "pipe" }
  );

  const app = createApp({
    principalResolver: {
      resolve: async (token) => (token === "invoice" ? principal : token === "other" ? otherPrincipal : null),
    },
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  const request = async (
    path: string,
    init: RequestInit = {},
    version: "v1" | "legacy" = "v1",
    token = "invoice"
  ) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const base = version === "v1" ? "/api/v1" : "/api";
    const response = await fetch(`http://127.0.0.1:${address.port}${base}${path}`, { ...init, headers });
    return { status: response.status, body: await response.json(), etag: response.headers.get("etag") };
  };
  const patch = (id: string, etag: string | undefined, dueDate: string, headers: Record<string, string> = {}) =>
    request(`/invoices/${id}`, {
      method: "PATCH",
      headers: { ...headers, ...(etag === undefined ? {} : { "if-match": etag }) },
      body: JSON.stringify({ dueDate }),
    });
  const expectStale = async (etag: string, label: string) => {
    const stale = await patch(invoice.id, etag, "2030-12-01");
    assert.equal(stale.status, 412, `${label} must invalidate the old ETag: ${JSON.stringify(stale.body)}`);
    assert.equal(problemCode(stale.body), "ETAG_VERSION_MISMATCH");
  };

  try {
    const initial = await request(`/invoices/${invoice.id}`);
    assert.equal(initial.status, 200);
    assert.ok(initial.etag, "v1 GET supplies a strong ETag for a legacy-null row");
    const initialEtag = initial.etag;
    const legacyRead = await request(`/invoices/${invoice.id}`, {}, "legacy");
    assert.match(legacyRead.etag ?? "", /^W\//u, "legacy keeps Express's representation ETag, not v1's resource ETag");
    assert.equal((await request(`/invoices/missing`)).status, 404);
    assert.equal((await request(`/invoices/${invoice.id}`, {}, "v1", "other")).status, 404);
    const missingWrite = await request(`/invoices/missing`, {
      method: "PATCH",
      body: JSON.stringify({ dueDate: "2030-02-01" }),
    });
    const foreignWrite = await request(
      `/invoices/${invoice.id}`,
      { method: "PATCH", body: JSON.stringify({ dueDate: "2030-02-01" }) },
      "v1",
      "other"
    );
    assert.equal(missingWrite.status, 404);
    assert.equal(foreignWrite.status, 404);

    for (const [tag, status] of [
      [undefined, 428],
      ["malformed", 400],
      ["W/\"x\"", 400],
      ["*", 400],
      ["\"x\", \"y\"", 400],
    ] as const) {
      const reply = await patch(invoice.id, tag, "2030-02-01");
      assert.equal(reply.status, status);
    }

    const siblingOrder = await prisma.order.create({
      data: { tenantId: tenant, customerId: customer.id, status: "INVOICED" },
    });
    const sibling = await prisma.invoice.create({
      data: {
        tenantId: tenant,
        number: "INV-CONDITIONAL-SIBLING",
        customerId: customer.id,
        orderId: siblingOrder.id,
        dueDate: new Date("2030-01-01"),
      },
    });
    const crossResource = await patch(sibling.id, initialEtag, "2030-02-01");
    assert.equal(crossResource.status, 412);
    assert.equal(problemCode(crossResource.body), "ETAG_RESOURCE_MISMATCH");

    const [one, two] = await Promise.all(
      ["2030-02-01", "2030-03-01"].map((dueDate) => patch(invoice.id, initialEtag, dueDate))
    );
    assert.equal([one, two].filter((reply) => reply.status === 200).length, 1);
    assert.equal([one, two].filter((reply) => reply.status === 412).length, 1);
    assert.ok((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).resourceVersion !== null);

    const current = await request(`/invoices/${invoice.id}`);
    assert.ok(current.etag);
    const currentEtag = current.etag;
    const replayHeaders = {
      "idempotency-key": "invoice-replay",
      "x-request-id": "invoice-replay-request",
    };
    const first = await patch(invoice.id, currentEtag, "2030-04-01", replayHeaders);
    const replay = await patch(invoice.id, currentEtag, "2030-04-01", replayHeaders);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.etag, first.etag, "idempotent replay restores the original response ETag");
    const replayEvents = await prisma.auditEvent.findMany({ where: { requestId: "invoice-replay-request" } });
    assert.equal(replayEvents.length, 1, "a replay must not append a second audit event");
    assert.equal(replayEvents[0]?.idempotencyKeyFingerprint, fingerprintIdempotencyKey("invoice-replay"));

    const beforeLegacy = await request(`/invoices/${invoice.id}`);
    const legacy = await request(
      `/invoices/${invoice.id}`,
      { method: "PUT", body: JSON.stringify({ dueDate: "2030-05-01" }) },
      "legacy"
    );
    assert.equal(legacy.status, 200);
    await expectStale(beforeLegacy.etag!, "headerless legacy update");

    const beforeRootSql = await request(`/invoices/${invoice.id}`);
    await prisma.$executeRaw`
      UPDATE "Invoice"
      SET "dueDate" = CURRENT_TIMESTAMP
      WHERE "id" = ${invoice.id}
    `;
    const rootVersion = await prisma.$queryRaw<{ readonly version: string; readonly type: string }[]>`
      SELECT CAST("resourceVersion" AS TEXT) AS version, typeof("resourceVersion") AS type
      FROM "Invoice" WHERE "id" = ${invoice.id}
    `;
    assert.equal(rootVersion[0]?.type, "integer");
    assert.match(rootVersion[0]?.version ?? "", /^[0-9]+$/u);
    await expectStale(beforeRootSql.etag!, "direct SQL root update");

    const beforeLine = await request(`/invoices/${invoice.id}`);
    await prisma.invoiceLine.create({
      data: { invoiceId: invoice.id, description: "direct", quantity: 1, unitPrice: 1, amount: 1 },
    });
    await expectStale(beforeLine.etag!, "direct invoice line write");

    const beforeTransmission = await request(`/invoices/${invoice.id}`);
    await prisma.$executeRaw`
      INSERT INTO "Transmission" ("id", "invoiceId", "method", "status", "createdAt", "updatedAt")
      VALUES ('invoice-conditional-transmission', ${invoice.id}, 'PORTAL', 'QUEUED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    await expectStale(beforeTransmission.etag!, "direct transmission write");

    const beforeLifecycle = await request(`/invoices/${invoice.id}`);
    await prisma.$executeRaw`
      UPDATE "Invoice"
      SET "status" = 'POSTED', "postedAt" = CURRENT_TIMESTAMP, "accountingDate" = '2030-01-01'
      WHERE "id" = ${invoice.id}
    `;
    await expectStale(beforeLifecycle.etag!, "direct invoice lifecycle transition");

    const payment = await prisma.payment.create({
      data: {
        tenantId: tenant,
        customerId: customer.id,
        amount: 1,
        amountDecimal: "1.0000",
        currencyCode: "USD",
      },
    });
    const beforeApplication = await request(`/invoices/${invoice.id}`);
    const application = await prisma.paymentApplication.create({
      data: { paymentId: payment.id, invoiceId: invoice.id, amount: 1, amountDecimal: "1.0000" },
    });
    await expectStale(beforeApplication.etag!, "direct payment application write");

    const beforeReversal = await request(`/invoices/${invoice.id}`);
    await prisma.paymentApplicationReversal.create({
      data: {
        paymentApplicationId: application.id,
        amountDecimal: "1.0000",
        reason: "direct evidence",
        accountingDate: "2030-01-01",
        actor: "system:meridian-api",
      },
    });
    await expectStale(beforeReversal.etag!, "direct payment reversal write");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
