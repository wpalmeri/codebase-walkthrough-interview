import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { join } from "node:path";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import { appendRequestAuditEvent, type RequestAuditMetadata } from "../audit/requestAudit";
import { updateRate, type RateMutationAudit } from "../controllers/rateController";
import { prisma } from "../db";
import { z } from "zod";

const tenantA = "conditional-rate-tenant-a";
const tenantB = "conditional-rate-tenant-b";
const migrationPath = join(
  process.cwd(),
  "prisma/migrations/20260922110000_rate_conditional_writes/migration.sql"
);

const principals: Record<string, Principal> = {
  "rate-admin-a": {
    tenantId: tenantA,
    subjectId: "conditional-rate-admin-a",
    credentialId: "conditional-rate-key-a",
    kind: "TENANT_API_KEY",
    role: "ADMIN",
  },
  "rate-admin-b": {
    tenantId: tenantB,
    subjectId: "conditional-rate-admin-b",
    credentialId: "conditional-rate-key-b",
    kind: "TENANT_API_KEY",
    role: "ADMIN",
  },
};

type ApiResponse = { readonly status: number; readonly body: unknown; readonly etag: string | null };

type PersistedAuditEvent = {
  readonly tenantId: string;
  readonly action: string;
  readonly principalKind: string;
  readonly principalSubject: string;
  readonly principalCredentialId: string;
  readonly requestId: string;
  readonly idempotencyKeyFingerprint: string | null;
  readonly resourceKind: string;
  readonly resourceId: string;
};

async function request(
  server: Server,
  version: "legacy" | "v1",
  token: keyof typeof principals,
  path: string,
  init: RequestInit = {}
): Promise<ApiResponse> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("rate conditional-write server has no TCP address");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const prefix = version === "v1" ? "/api/v1" : "/api";
  const response = await fetch(`http://127.0.0.1:${address.port}${prefix}${path}`, { ...init, headers });
  return { status: response.status, body: await response.json(), etag: response.headers.get("etag") };
}

function problemCode(body: unknown): string {
  return z.object({ code: z.string() }).passthrough().parse(body).code;
}

function responsePrice(body: unknown): string {
  return z.object({ unitPriceDecimal: z.string() }).passthrough().parse(body).unitPriceDecimal;
}

async function auditEvents(): Promise<PersistedAuditEvent[]> {
  return prisma.auditEvent.findMany({
    orderBy: { occurredAt: "asc" },
    select: {
      tenantId: true,
      action: true,
      principalKind: true,
      principalSubject: true,
      principalCredentialId: true,
      requestId: true,
      idempotencyKeyFingerprint: true,
      resourceKind: true,
      resourceId: true,
    },
  });
}

async function auditEventForRequest(requestId: string): Promise<PersistedAuditEvent | null> {
  return prisma.auditEvent.findFirst({
    where: { requestId },
    select: {
      tenantId: true,
      action: true,
      principalKind: true,
      principalSubject: true,
      principalCredentialId: true,
      requestId: true,
      idempotencyKeyFingerprint: true,
      resourceKind: true,
      resourceId: true,
    },
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seedPreexistingRates(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Conditional Rate Tenant A" },
      { id: tenantB, slug: tenantB, name: "Conditional Rate Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: "conditional-rate-customer-a", tenantId: tenantA, name: "Rate customer A", email: "rate-a@example.com" },
      { id: "conditional-rate-customer-b", tenantId: tenantB, name: "Rate customer B", email: "rate-b@example.com" },
    ],
  });
  await prisma.product.createMany({
    data: [
      {
        id: "conditional-rate-product-a",
        tenantId: tenantA,
        sku: "CONDITIONAL-RATE-A",
        name: "Rate product A",
        unit: "seat",
        listPrice: 10,
        listPriceDecimal: "10.0000",
        currencyCode: "USD",
      },
      {
        id: "conditional-rate-product-b",
        tenantId: tenantB,
        sku: "CONDITIONAL-RATE-B",
        name: "Rate product B",
        unit: "seat",
        listPrice: 20,
        listPriceDecimal: "20.0000",
        currencyCode: "USD",
      },
      {
        id: "conditional-rate-product-a-new",
        tenantId: tenantA,
        sku: "CONDITIONAL-RATE-A-NEW",
        name: "Rate product A (new)",
        unit: "seat",
        listPrice: 8,
        listPriceDecimal: "8.0000",
        currencyCode: "USD",
      },
    ],
  });
  await prisma.rate.createMany({
    data: [
      {
        id: "conditional-rate-a",
        customerId: "conditional-rate-customer-a",
        productId: "conditional-rate-product-a",
        unitPrice: 9,
        unitPriceDecimal: "9.0000",
        currencyCode: "USD",
        // Bypass the current Prisma-client create default to model a row that
        // genuinely existed before the conditional-write migration.
        resourceVersion: null,
      },
      {
        id: "conditional-rate-b",
        customerId: "conditional-rate-customer-b",
        productId: "conditional-rate-product-b",
        unitPrice: 19,
        unitPriceDecimal: "19.0000",
        currencyCode: "USD",
        resourceVersion: null,
      },
    ],
  });
  assert.equal((await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-a" } })).resourceVersion, null);
}

async function main(): Promise<void> {
  await seedPreexistingRates();
  // This is deliberately separate from the pre-existing seed above.
  execFileSync(
    join(process.cwd(), "node_modules/.bin/prisma"),
    ["db", "execute", "--url", process.env.DATABASE_URL ?? "", "--file", migrationPath],
    { cwd: process.cwd(), env: process.env, stdio: "pipe" }
  );
  await prisma.rate.create({
    data: {
      id: "conditional-rate-created-after-migration",
      customerId: "conditional-rate-customer-a",
      productId: "conditional-rate-product-a-new",
      unitPrice: 8,
      unitPriceDecimal: "8.0000",
      currencyCode: "USD",
    },
  });
  assert.equal(
    (await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-created-after-migration" } })).resourceVersion,
    1
  );

  const app = createApp({
    principalResolver: { resolve: async (token) => principals[token] ?? null },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const initial = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a");
    assert.equal(initial.status, 200);
    assert.ok(initial.etag !== null);
    assert.equal(responsePrice(initial.body), "9.0000");

    const missingCondition = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      body: JSON.stringify({ unitPrice: "10.0000" }),
    });
    assert.equal(missingCondition.status, 428);
    assert.equal(problemCode(missingCondition.body), "PRECONDITION_REQUIRED");

    const malformedCondition = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: { "if-match": "not-an-etag" },
      body: JSON.stringify({ unitPrice: "10.0000" }),
    });
    assert.equal(malformedCondition.status, 400);
    assert.equal(problemCode(malformedCondition.body), "IF_MATCH_MALFORMED");
    assert.deepEqual(
      z.object({ type: z.string(), title: z.string() }).passthrough().parse(malformedCondition.body),
      {
        type: "urn:meridian:problem:invalid-if-match",
        title: "Bad Request",
        status: 400,
        code: "IF_MATCH_MALFORMED",
        detail: "If-Match must contain one supported strong resource ETag",
      }
    );

    const sameTenantOther = await request(
      server,
      "v1",
      "rate-admin-a",
      "/rates/conditional-rate-created-after-migration"
    );
    assert.ok(sameTenantOther.etag !== null);
    const wrongResourceCondition = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: { "if-match": sameTenantOther.etag },
      body: JSON.stringify({ unitPrice: "10.0000" }),
    });
    assert.equal(wrongResourceCondition.status, 412);
    assert.equal(problemCode(wrongResourceCondition.body), "ETAG_RESOURCE_MISMATCH");

    const foreign = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-b", {
      method: "PUT",
      headers: { "if-match": "not-an-etag" },
      body: JSON.stringify({ unitPrice: "1.0000" }),
    });
    const missing = await request(server, "v1", "rate-admin-a", "/rates/missing-rate", {
      method: "PUT",
      headers: { "if-match": "not-an-etag" },
      body: JSON.stringify({ unitPrice: "1.0000" }),
    });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, missing.body);
    assert.equal((await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-b" } })).unitPrice, 19);
    // Validation, visibility failures, and failed If-Match checks never mutate
    // and therefore cannot emit a lifecycle event.
    assert.equal((await auditEvents()).length, 0);

    const staleTag = initial.etag;
    const [firstWriter, secondWriter] = await Promise.all([
      request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
        method: "PUT",
        headers: { "if-match": staleTag },
        body: JSON.stringify({ unitPrice: "10.0000" }),
      }),
      request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
        method: "PUT",
        headers: { "if-match": staleTag },
        body: JSON.stringify({ unitPrice: "11.0000" }),
      }),
    ]);
    const successfulWriter = [firstWriter, secondWriter].filter(({ status }) => status === 200);
    const staleWriter = [firstWriter, secondWriter].filter(({ status }) => status === 412);
    assert.equal(successfulWriter.length, 1);
    assert.equal(staleWriter.length, 1);
    assert.equal(problemCode(staleWriter[0]?.body), "ETAG_VERSION_MISMATCH");
    assert.ok(successfulWriter[0]?.etag !== null && successfulWriter[0]?.etag !== staleTag);
    const persistedAfterRace = await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-a" } });
    assert.equal(persistedAfterRace.resourceVersion, 1);
    const persistedPrice = persistedAfterRace.unitPriceDecimal?.toFixed(4);
    assert.ok(persistedPrice !== undefined);
    assert.equal(persistedPrice, responsePrice(successfulWriter[0]?.body));
    assert.equal((await auditEvents()).length, 1);

    const current = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a");
    assert.equal(current.status, 200);
    assert.ok(current.etag !== null);
    const idempotencyHeaders = {
      "if-match": current.etag,
      "idempotency-key": "conditional-rate-replay",
      "idempotency-client": "rate-conditional-integration",
      "x-request-id": "audit-conditional-request-1",
    };
    const idempotentFirst = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: idempotencyHeaders,
      body: JSON.stringify({ unitPrice: "12.0000" }),
    });
    const idempotentReplay = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: idempotencyHeaders,
      body: JSON.stringify({ unitPrice: "12.0000" }),
    });
    assert.equal(idempotentFirst.status, 200);
    assert.equal(idempotentReplay.status, 200);
    assert.equal(idempotentReplay.etag, idempotentFirst.etag);
    assert.deepEqual(idempotentReplay.body, idempotentFirst.body);
    assert.equal((await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-a" } })).resourceVersion, 2);
    const conditionalAudits = await auditEvents();
    assert.equal(conditionalAudits.length, 2);
    assert.deepEqual(await auditEventForRequest("audit-conditional-request-1"), {
      tenantId: tenantA,
      action: "RATE_UPDATED",
      principalKind: "TENANT_API_KEY",
      principalSubject: "conditional-rate-admin-a",
      principalCredentialId: "conditional-rate-key-a",
      requestId: "audit-conditional-request-1",
      idempotencyKeyFingerprint: fingerprintIdempotencyKey("conditional-rate-replay"),
      resourceKind: "RATE",
      resourceId: "conditional-rate-a",
    });
    assert.equal(JSON.stringify(conditionalAudits).includes("conditional-rate-replay"), false);

    const keyWithDifferentCondition = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: {
        ...idempotencyHeaders,
        "if-match": idempotentFirst.etag ?? "",
      },
      body: JSON.stringify({ unitPrice: "12.0000" }),
    });
    assert.equal(keyWithDifferentCondition.status, 409);
    assert.equal(problemCode(keyWithDifferentCondition.body), "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await auditEvents()).length, 2);

    const directEtag = (await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a")).etag;
    assert.ok(directEtag !== null);
    await prisma.rate.update({ where: { id: "conditional-rate-a" }, data: { unitPrice: 13, unitPriceDecimal: "13.0000" } });
    const directWriteStale = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: { "if-match": directEtag },
      body: JSON.stringify({ unitPrice: "14.0000" }),
    });
    assert.equal(directWriteStale.status, 412);
    assert.equal(problemCode(directWriteStale.body), "ETAG_VERSION_MISMATCH");
    assert.equal((await auditEvents()).length, 2);

    const beforeLegacyWrite = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a");
    assert.ok(beforeLegacyWrite.etag !== null);
    const legacy = await request(server, "legacy", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: { "x-request-id": "audit-legacy-request-1" },
      body: JSON.stringify({ unitPrice: "14.0000" }),
    });
    assert.equal(legacy.status, 200);
    assert.equal(responsePrice(legacy.body), "14.0000");
    const staleAfterLegacyWrite = await request(server, "v1", "rate-admin-a", "/rates/conditional-rate-a", {
      method: "PUT",
      headers: { "if-match": beforeLegacyWrite.etag },
      body: JSON.stringify({ unitPrice: "15.0000" }),
    });
    assert.equal(staleAfterLegacyWrite.status, 412);
    assert.equal(problemCode(staleAfterLegacyWrite.body), "ETAG_VERSION_MISMATCH");

    assert.deepEqual(await auditEventForRequest("audit-legacy-request-1"), {
      tenantId: tenantA,
      action: "RATE_UPDATED",
      principalKind: "TENANT_API_KEY",
      principalSubject: "conditional-rate-admin-a",
      principalCredentialId: "conditional-rate-key-a",
      requestId: "audit-legacy-request-1",
      idempotencyKeyFingerprint: null,
      resourceKind: "RATE",
      resourceId: "conditional-rate-a",
    });

    const beforeFailedAudit = await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-a" } });
    const existingAuditId = (
      await prisma.auditEvent.findFirstOrThrow({ select: { id: true }, orderBy: { occurredAt: "asc" } })
    ).id;
    const failingAudit: RateMutationAudit = {
      metadata: {
        tenantId: tenantA,
        principal: {
          kind: "TENANT_API_KEY",
          subjectId: "forced-audit-subject",
          credentialId: "forced-audit-credential",
        },
        requestId: "audit-forced-failure-1",
      } satisfies RequestAuditMetadata,
      append: (repository, metadata, event) =>
        appendRequestAuditEvent(repository, metadata, event, {
          createId: () => existingAuditId,
          now: () => new Date("2026-09-22T15:00:00.000Z"),
        }),
    };
    await assert.rejects(
      updateRate(tenantA, "conditional-rate-a", { unitPrice: "16.0000" }, failingAudit),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
    );
    const afterFailedAudit = await prisma.rate.findUniqueOrThrow({ where: { id: "conditional-rate-a" } });
    assert.equal(afterFailedAudit.unitPriceDecimal?.toFixed(4), beforeFailedAudit.unitPriceDecimal?.toFixed(4));
    assert.equal(afterFailedAudit.resourceVersion, beforeFailedAudit.resourceVersion);
    assert.equal(await auditEventForRequest("audit-forced-failure-1"), null);

    const combo = await request(server, "v1", "rate-admin-a", "/rates/combos", {
      method: "POST",
      headers: {
        "x-request-id": "audit-combo-request-1",
        "idempotency-key": "combo-audit-idempotency-key",
      },
      body: JSON.stringify({
        name: "Audit combo",
        productIds: ["conditional-rate-product-a"],
        percentOff: "5.0000",
      }),
    });
    assert.equal(combo.status, 200);
    const comboId = z.object({ id: z.string() }).passthrough().parse(combo.body).id;
    assert.deepEqual(await auditEventForRequest("audit-combo-request-1"), {
      tenantId: tenantA,
      action: "COMBO_DISCOUNT_CREATED",
      principalKind: "TENANT_API_KEY",
      principalSubject: "conditional-rate-admin-a",
      principalCredentialId: "conditional-rate-key-a",
      requestId: "audit-combo-request-1",
      idempotencyKeyFingerprint: fingerprintIdempotencyKey("combo-audit-idempotency-key"),
      resourceKind: "COMBO_DISCOUNT",
      resourceId: comboId,
    });
  } finally {
    await close(server);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
