import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { closeAccountingPeriod, type AccountingPeriodCloseStore, type AccountingPeriodCloseTransaction } from "../controllers/accountingPeriodCloseController";
import { prisma } from "../db";

const alpha = "accounting-close-alpha";
const beta = "accounting-close-beta";
const principals: Record<string, Principal> = {
  alphaAdmin: { tenantId: alpha, subjectId: "tenant:alpha", credentialId: "accounting-close-alpha-admin", kind: "TENANT_API_KEY", role: "ADMIN" },
  alphaBilling: { tenantId: alpha, subjectId: "tenant:alpha", credentialId: "accounting-close-alpha-billing", kind: "TENANT_API_KEY", role: "BILLING" },
  alphaLegacy: { tenantId: alpha, subjectId: "legacy:alpha", credentialId: "legacy:alpha", kind: "LEGACY_API_KEY", role: "ADMIN" },
  betaAdmin: { tenantId: beta, subjectId: "tenant:beta", credentialId: "accounting-close-beta-admin", kind: "TENANT_API_KEY", role: "ADMIN" },
};

const closeStore: AccountingPeriodCloseStore = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the close domain exposes the transaction's exact narrow delegate surface.
  $transaction: (operation) => prisma.$transaction((transaction) => operation(transaction as unknown as AccountingPeriodCloseTransaction)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function request(
  server: Server, token: keyof typeof principals, path: string, body: unknown, headers: Record<string, string> = {}
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  if (!isRecord(responseBody)) {
    throw new Error("expected an object JSON response");
  }
  return { status: response.status, body: responseBody };
}

async function main(): Promise<void> {
  await prisma.tenant.createMany({ data: [
    { id: alpha, slug: alpha, name: "Accounting close alpha" },
    { id: beta, slug: beta, name: "Accounting close beta" },
  ] });
  await prisma.tenantApiKey.createMany({ data: [
    { id: "accounting-close-alpha-admin", tenantId: alpha, name: "alpha admin", role: "ADMIN", keyPrefix: "mrd_acctclosealpha", keyHash: "hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { id: "accounting-close-alpha-admin-two", tenantId: alpha, name: "alpha admin two", role: "ADMIN", keyPrefix: "mrd_acctclosealphatwo", keyHash: "hmac-sha256:v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
    { id: "accounting-close-alpha-billing", tenantId: alpha, name: "alpha billing", role: "BILLING", keyPrefix: "mrd_acctclosebilling", keyHash: "hmac-sha256:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { id: "accounting-close-beta-admin", tenantId: beta, name: "beta admin", role: "ADMIN", keyPrefix: "mrd_acctclosebeta", keyHash: "hmac-sha256:v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
  ] });
  await assert.rejects(
    closeAccountingPeriod(
      closeStore,
      { tenantId: "accounting-close-missing", subjectId: "tenant:missing", credentialId: "missing-admin", kind: "TENANT_API_KEY", role: "ADMIN" },
      { closedThroughDate: "2026-01-31" },
      { tenantId: "accounting-close-missing", principal: { kind: "TENANT_API_KEY", subjectId: "tenant:missing", credentialId: "missing-admin" }, requestId: "missing-tenant" },
    ),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "TENANT_NOT_FOUND",
  );
  await assert.rejects(
    closeAccountingPeriod(
      closeStore,
      principals.alphaAdmin,
      { closedThroughDate: "2026-01-31" },
      { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "accounting-close-alpha-admin-two" }, requestId: "forged-close-actor" },
    ),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "AUDIT_IDENTITY_MISMATCH",
  );
  let exhaustedCloseAttempts = 0;
  const exhaustedStore: AccountingPeriodCloseStore = {
    $transaction: async () => {
      exhaustedCloseAttempts += 1;
      throw Object.assign(new Error("database is locked"), { code: "P2034" });
    },
  };
  await assert.rejects(
    closeAccountingPeriod(
      exhaustedStore,
      principals.alphaAdmin,
      { closedThroughDate: "2026-01-31" },
      { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "accounting-close-alpha-admin" }, requestId: "exhausted-close-race" },
    ),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "CONCURRENT_ACCOUNTING_PERIOD_CLOSE",
  );
  assert.equal(exhaustedCloseAttempts, 2, "retryable close races are bounded before the stable conflict");
  await prisma.customer.create({ data: { id: "accounting-close-customer", tenantId: alpha, name: "Close gate customer", email: "close-gate@example.com", portalAccount: "close-gate-portal" } });
  await prisma.order.create({ data: { id: "accounting-close-order", tenantId: alpha, customerId: "accounting-close-customer", currencyCode: "USD" } });
  await prisma.invoice.create({ data: {
    id: "accounting-close-missing-date", tenantId: alpha, number: "ACCOUNTING-CLOSE-MISSING-DATE", customerId: "accounting-close-customer", orderId: "accounting-close-order",
    status: "DRAFT", total: 1, totalDecimal: "1.0000", amountPaid: 0, amountPaidDecimal: "0.0000", currencyCode: "USD", dueDate: new Date("2026-02-28T00:00:00.000Z"),
  } });
  await prisma.invoice.update({ where: { id: "accounting-close-missing-date" }, data: { status: "POSTED" } });
  const app = createApp({ environment: "test", apiKey: "", principalResolver: { resolve: async (token) => principals[token] ?? null } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    assert.equal((await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-30" })).status, 400, "strict dates reject impossible calendar values");
    assert.equal((await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31", extra: true })).status, 400, "body is strict");
    assert.equal((await request(server, "alphaBilling", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" })).status, 403);
    assert.equal((await request(server, "alphaLegacy", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" })).status, 403);
    const missingDate = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" });
    assert.deepEqual([missingDate.status, missingDate.body.code], [412, "FINALIZED_INVOICE_ACCOUNTING_DATE_MISSING"]);
    await prisma.invoice.update({ where: { id: "accounting-close-missing-date" }, data: { accountingDate: "2026-01-15" } });

    const idempotencyKey = "accounting-close-first";
    const first = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" }, {
      "x-request-id": "accounting-close-first-request", "idempotency-key": idempotencyKey, "idempotency-client": "close-console",
    });
    assert.deepEqual([first.status, first.body.state, first.body.closedThroughDate], [200, "CLOSED", "2026-01-31"]);
    const replay = await request(server, "alphaAdmin", "/api/accounting-periods/close", { closedThroughDate: "2026-01-31" }, {
      "x-request-id": "different-replay-request", "idempotency-key": idempotencyKey, "idempotency-client": "close-console",
    });
    assert.deepEqual(replay, first, "legacy alias shares the normalized idempotency scope");
    const alphaControl = await prisma.tenantAccountingPeriodControl.findUniqueOrThrow({ where: { tenantId: alpha } });
    const audits = await prisma.auditEvent.findMany({ where: { tenantId: alpha, action: "ACCOUNTING_PERIOD_CLOSED" } });
    assert.equal(audits.length, 1);
    assert.deepEqual(
      [audits[0]?.resourceId, audits[0]?.principalCredentialId, audits[0]?.requestId, audits[0]?.idempotencyKeyFingerprint],
      [alphaControl.id, "accounting-close-alpha-admin", "accounting-close-first-request", fingerprintIdempotencyKey(idempotencyKey)],
    );
    const equal = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" });
    assert.deepEqual([equal.status, equal.body.state], [200, "ALREADY_CLOSED"]);
    assert.equal(await prisma.auditEvent.count({ where: { tenantId: alpha, action: "ACCOUNTING_PERIOD_CLOSED" } }), 1);
    const changedReplay = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-01" }, {
      "idempotency-key": idempotencyKey, "idempotency-client": "close-console",
    });
    assert.deepEqual([changedReplay.status, changedReplay.body.code], [409, "IDEMPOTENCY_KEY_REUSED"]);

    const competing = await Promise.all([
      request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-15" }, { "idempotency-key": "accounting-close-race-one" }),
      request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-15" }, { "idempotency-key": "accounting-close-race-two" }),
    ]);
    assert.deepEqual(competing.map((result) => result.status).toSorted((left, right) => left - right), [200, 200]);
    const competingStates = competing.map((result) => {
      const state = result.body.state;
      if (typeof state !== "string") throw new Error("close response state must be a string");
      return state;
    });
    assert.deepEqual(competingStates.toSorted((left, right) => left.localeCompare(right)), ["ALREADY_CLOSED", "CLOSED"]);

    const lowerAfterRace = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" });
    assert.deepEqual([lowerAfterRace.status, lowerAfterRace.body.code], [409, "ACCOUNTING_PERIOD_CLOSE_MOVES_BACKWARD"]);
    assert.equal(await prisma.auditEvent.count({ where: { tenantId: alpha, action: "ACCOUNTING_PERIOD_CLOSED" } }), 2);
    const advanced = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-28" });
    assert.deepEqual([advanced.status, advanced.body.state], [200, "CLOSED"]);
    const lower = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-27" });
    assert.deepEqual([lower.status, lower.body.code], [409, "ACCOUNTING_PERIOD_CLOSE_MOVES_BACKWARD"]);
    assert.equal((await prisma.tenantAccountingPeriodControl.findUniqueOrThrow({ where: { tenantId: alpha } })).closedThroughDate, "2026-02-28");
    await assert.rejects(
      closeAccountingPeriod(
        closeStore,
        principals.alphaAdmin,
        { closedThroughDate: "2026-03-31" },
        { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "accounting-close-alpha-admin" }, requestId: "accounting-close-audit-rollback" },
        { appendAudit: async () => { throw new Error("forced close audit failure"); } },
      )
    );
    assert.equal((await prisma.tenantAccountingPeriodControl.findUniqueOrThrow({ where: { tenantId: alpha } })).closedThroughDate, "2026-02-28", "an audit failure rolls back the close advance");

    const betaClose = await request(server, "betaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" });
    assert.equal(betaClose.status, 200, "tenant controls remain isolated");
    await prisma.tenantApiKey.update({ where: { id: "accounting-close-alpha-admin" }, data: { revokedAt: new Date() } });
    const stale = await request(server, "alphaAdmin", "/api/v1/accounting-periods/close", { closedThroughDate: "2026-03-31" });
    assert.equal(stale.status, 403, "the actor is revalidated inside the close transaction");
  } finally {
    await close(server);
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
