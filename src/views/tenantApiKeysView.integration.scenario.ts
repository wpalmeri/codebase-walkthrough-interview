import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import {
  issueTenantApiKeyForAdmin,
  revokeTenantApiKeyForAdmin,
  type TenantApiKeyAdministrationStore,
  type TenantApiKeyAdministrationTransaction,
} from "../auth/tenantApiKeyLifecycle";
import { prisma } from "../db";

const pepper = "tenant-api-key-admin-test-pepper-at-least-32-characters";
const alpha = "tenant-api-key-admin-alpha";
const beta = "tenant-api-key-admin-beta";

const principals: Record<string, Principal> = {
  alphaAdmin: { tenantId: alpha, subjectId: "tenant:alpha", credentialId: "alpha-admin", kind: "TENANT_API_KEY", role: "ADMIN" },
  alphaAdminTwo: { tenantId: alpha, subjectId: "tenant:alpha", credentialId: "alpha-admin-two", kind: "TENANT_API_KEY", role: "ADMIN" },
  alphaBilling: { tenantId: alpha, subjectId: "tenant:alpha", credentialId: "alpha-billing", kind: "TENANT_API_KEY", role: "BILLING" },
  alphaLegacyAdmin: { tenantId: alpha, subjectId: "legacy:alpha", credentialId: "legacy:alpha", kind: "LEGACY_API_KEY", role: "ADMIN" },
};

type ApiResponse = { readonly status: number; readonly body: unknown; readonly cacheControl: string | null; readonly pragma: string | null };

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}

async function request(server: Server, token: keyof typeof principals, path: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control"), pragma: response.headers.get("pragma") };
}

function responseField(body: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) throw new Error(`missing ${path}`);
    const value = new Map(Object.entries(current)).get(key);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }, body);
}

function requiredString(body: unknown, path: string): string {
  const value = responseField(body, path);
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function adminStore(): TenantApiKeyAdministrationStore {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Prisma omits client-only methods from this transaction type; this scenario uses only the narrowed lifecycle delegates.
    $transaction: (operation) => prisma.$transaction((tx) => operation(tx as unknown as TenantApiKeyAdministrationTransaction)),
  };
}

async function main(): Promise<void> {
  await prisma.tenant.createMany({ data: [
    { id: alpha, slug: alpha, name: "Alpha tenant" },
    { id: beta, slug: beta, name: "Beta tenant" },
  ] });
  await prisma.tenantApiKey.createMany({ data: [
    { id: "alpha-admin", tenantId: alpha, name: "alpha admin", role: "ADMIN", keyPrefix: "mrd_alphaadmin", keyHash: "hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { id: "alpha-admin-two", tenantId: alpha, name: "alpha admin two", role: "ADMIN", keyPrefix: "mrd_alphaadmintwo", keyHash: "hmac-sha256:v1:7777777777777777777777777777777777777777777777777777777777777777" },
    { id: "alpha-billing", tenantId: alpha, name: "alpha billing", role: "BILLING", keyPrefix: "mrd_alphabilling", keyHash: "hmac-sha256:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { id: "alpha-race", tenantId: alpha, name: "alpha race", role: "VIEWER", keyPrefix: "mrd_alpharace", keyHash: "hmac-sha256:v1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    { id: "alpha-audit-failure", tenantId: alpha, name: "alpha audit failure", role: "VIEWER", keyPrefix: "mrd_alphaauditfail", keyHash: "hmac-sha256:v1:9999999999999999999999999999999999999999999999999999999999999999" },
    { id: "beta-target", tenantId: beta, name: "beta target", role: "VIEWER", keyPrefix: "mrd_betatarget", keyHash: "hmac-sha256:v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
  ] });

  const app = createApp({
    environment: "test",
    apiKey: "",
    apiKeyPepper: pepper,
    principalResolver: { resolve: async (token) => principals[token] ?? null },
  });
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const rejectedIdempotency = await request(server, "alphaAdmin", "/tenant-api-keys", { name: "rejected", role: "VIEWER" }, { "Idempotency-Key": "one-time-key" });
    assert.equal(rejectedIdempotency.status, 400);
    assert.equal(responseField(rejectedIdempotency.body, "code"), "IDEMPOTENCY_NOT_SUPPORTED");
    assert.equal(await prisma.idempotencyRecord.count(), 0, "one-time-token issuance must not reserve/replay a response");

    assert.equal((await request(server, "alphaBilling", "/tenant-api-keys", { name: "billing denied", role: "VIEWER" })).status, 403);
    assert.equal((await request(server, "alphaLegacyAdmin", "/tenant-api-keys", { name: "bridge denied", role: "VIEWER" })).status, 403);
    const oversizedKeyId = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "x".repeat(192) });
    assert.deepEqual([oversizedKeyId.status, responseField(oversizedKeyId.body, "code")], [400, "VALIDATION_ERROR"]);
    const selfRevoke = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "alpha-admin" });
    assert.deepEqual([selfRevoke.status, responseField(selfRevoke.body, "code")], [409, "TENANT_API_KEY_SELF_REVOCATION"]);
    assert.equal((await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: "alpha-admin" } })).revokedAt, null);
    assert.equal(await prisma.auditEvent.count({ where: { action: "TENANT_API_KEY_REVOKED", resourceId: "alpha-admin" } }), 0);

    const issued = await request(server, "alphaAdmin", "/tenant-api-keys", { name: "portal worker", role: "BILLING" });
    assert.equal(issued.status, 201);
    assert.equal(issued.cacheControl, "no-store");
    assert.equal(issued.pragma, "no-cache");
    const token = requiredString(issued.body, "token");
    const keyId = requiredString(issued.body, "key.id");
    assert.equal(JSON.stringify(issued.body).split(token).length - 1, 1, "the response contains the token once");
    const stored = await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: keyId } });
    assert.equal(JSON.stringify(stored).includes(token), false, "the row never retains plaintext credentials");
    const issuedAudit = await prisma.auditEvent.findMany({ where: { action: "TENANT_API_KEY_ISSUED", resourceId: keyId } });
    assert.equal(issuedAudit.length, 1);
    assert.equal(JSON.stringify(issuedAudit).includes(token), false, "audit rows never retain plaintext credentials");

    const foreign = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "beta-target" });
    const missing = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "not-a-real-key" });
    assert.deepEqual([foreign.status, responseField(foreign.body, "code")], [missing.status, responseField(missing.body, "code")]);
    assert.deepEqual([foreign.status, responseField(foreign.body, "code")], [404, "TENANT_API_KEY_NOT_FOUND"]);

    const revokeHeaders = { "Idempotency-Key": "revoke-once", "Idempotency-Client": "operator-console" };
    const revoked = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId }, revokeHeaders);
    const replayed = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId }, revokeHeaders);
    assert.equal(revoked.status, 200);
    assert.deepEqual(replayed, revoked, "a completed revocation is replayed without another mutation");
    assert.equal(await prisma.auditEvent.count({ where: { action: "TENANT_API_KEY_REVOKED", resourceId: keyId } }), 1);
    assert.equal(JSON.stringify(await prisma.idempotencyRecord.findMany()).includes(token), false, "idempotency persistence never contains the issued token");

    const concurrent = await Promise.all([
      request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "alpha-race" }),
      request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "alpha-race" }),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).toSorted((left, right) => left - right), [200, 200]);
    assert.equal(await prisma.auditEvent.count({ where: { action: "TENANT_API_KEY_REVOKED", resourceId: "alpha-race" } }), 1, "concurrent revocations append one transition audit event");
    const alreadyRevoked = await request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "alpha-race" });
    assert.equal(responseField(alreadyRevoked.body, "key.state"), "ALREADY_REVOKED");
    assert.equal(await prisma.auditEvent.count({ where: { action: "TENANT_API_KEY_REVOKED", resourceId: "alpha-race" } }), 1, "an already-revoked key never creates another audit event");

    await assert.rejects(
      revokeTenantApiKeyForAdmin(
        adminStore(), principals.alphaAdmin, { keyId: "alpha-audit-failure" },
        { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "alpha-admin" }, requestId: "revoke-audit-rollback" },
        { appendAudit: async () => { throw new Error("forced revoke audit failure"); } }
      )
    );
    assert.equal((await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: "alpha-audit-failure" } })).revokedAt, null, "a failed revoke audit rolls back revokedAt");
    assert.equal(await prisma.auditEvent.count({ where: { action: "TENANT_API_KEY_REVOKED", resourceId: "alpha-audit-failure" } }), 0);

    // Forced audit failure must abort the enclosing issue transaction, leaving no credential behind.
    await assert.rejects(
      issueTenantApiKeyForAdmin(
        adminStore(),
        principals.alphaAdmin,
        { name: "audit rollback", role: "VIEWER" },
        { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "alpha-admin" }, requestId: "audit-rollback" },
        pepper,
        { tokenGenerator: () => "mrd_auditrollback_abcdefghijklmnopqrstuvwxyz123456", appendAudit: async () => { throw new Error("forced audit failure"); } }
      )
    );
    assert.equal(await prisma.tenantApiKey.count({ where: { tenantId: alpha, name: "audit rollback" } }), 0);

    // A prefix collision retries the entire transaction and writes exactly one audited credential.
    await prisma.tenantApiKey.create({ data: { tenantId: alpha, name: "collision holder", role: "VIEWER", keyPrefix: "mrd_collisiona", keyHash: "hmac-sha256:v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" } });
    let attempts = 0;
    const retried = await issueTenantApiKeyForAdmin(
      adminStore(), principals.alphaAdmin, { name: "collision retried", role: "VIEWER" },
      { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "alpha-admin" }, requestId: "collision-retry" }, pepper,
      { tokenGenerator: () => (++attempts === 1 ? "mrd_collisiona_abcdefghijklmnopqrstuvwxyz123456" : "mrd_collisionb_abcdefghijklmnopqrstuvwxyz123456") }
    );
    assert.equal(attempts, 2);
    assert.equal(await prisma.auditEvent.count({ where: { action: "TENANT_API_KEY_ISSUED", resourceId: retried.id } }), 1);

    await prisma.tenantApiKey.create({ data: { id: "inactive-admin", tenantId: alpha, name: "inactive admin", role: "ADMIN", keyPrefix: "mrd_inactiveadmin", keyHash: "hmac-sha256:v1:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", revokedAt: new Date() } });
    await assert.rejects(
      issueTenantApiKeyForAdmin(
        adminStore(),
        { tenantId: alpha, subjectId: "tenant:alpha", credentialId: "inactive-admin", kind: "TENANT_API_KEY", role: "ADMIN" },
        { name: "stale actor blocked", role: "VIEWER" },
        { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "inactive-admin" }, requestId: "stale-actor" },
        pepper
      ),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ACTING_KEY_NOT_ACTIVE"
    );
    assert.equal(await prisma.tenantApiKey.count({ where: { tenantId: alpha, name: "stale actor blocked" } }), 0);

    await assert.rejects(
      issueTenantApiKeyForAdmin(
        adminStore(), principals.alphaAdmin, { name: "spoofed audit actor", role: "VIEWER" },
        { tenantId: alpha, principal: { kind: "TENANT_API_KEY", subjectId: "tenant:alpha", credentialId: "alpha-admin-two" }, requestId: "spoofed-actor" },
        pepper
      ),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "AUDIT_IDENTITY_MISMATCH"
    );
    assert.equal(await prisma.tenantApiKey.count({ where: { tenantId: alpha, name: "spoofed audit actor" } }), 0);

    const crossed = await Promise.all([
      request(server, "alphaAdmin", "/tenant-api-keys/revoke", { keyId: "alpha-admin-two" }),
      request(server, "alphaAdminTwo", "/tenant-api-keys/revoke", { keyId: "alpha-admin" }),
    ]);
    assert.equal(crossed.filter(({ status }) => status === 200).length, 1, "competing administrators cannot revoke each other");
    assert.equal(crossed.some(({ status }) => status === 403 || status === 409), true);
    assert.equal(await prisma.tenantApiKey.count({ where: { tenantId: alpha, role: "ADMIN", revokedAt: null } }), 1);
  } finally {
    await close(server);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
