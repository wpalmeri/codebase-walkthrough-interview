import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import { createApp } from "../app";
import type { Principal } from "./principal";
import {
  apiKeyHash,
  createTenantPrincipalResolver,
  type TenantApiKeyReader,
  type TenantPrincipalResolver,
} from "./tenantPrincipal";

const token = "mrd_tenantkey1_abcdefghijklmnopqrstuvwxyz123456";
const pepper = "unit-test-pepper-with-at-least-32-characters";
const tenantPrincipal: Principal = {
  tenantId: "tenant-auth-a",
  subjectId: "tenant:tenant-auth-a",
  credentialId: "credential-auth-a",
  kind: "TENANT_API_KEY",
  role: "BILLING",
};

async function withServer<T>(app: ReturnType<typeof createApp>, operation: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }
}

function reader(overrides: Partial<Awaited<ReturnType<TenantApiKeyReader["findByPrefix"]>>> = {}): TenantApiKeyReader {
  return {
    async findByPrefix(keyPrefix) {
      if (keyPrefix !== "mrd_tenantkey1") return null;
      return {
        id: "credential-auth-a",
        tenantId: "tenant-auth-a",
        role: "BILLING",
        keyHash: apiKeyHash(token, pepper),
        revokedAt: null,
        ...overrides,
      };
    },
  };
}

void describe("tenant principal authentication", () => {
  void test("uses strict opaque tokens, a versioned HMAC, and revoked-key rejection without retaining the secret", async () => {
    const resolver = createTenantPrincipalResolver(reader(), pepper);
    const principal = await resolver.resolve(token);
    assert.deepEqual(principal, tenantPrincipal);
    assert.equal(await resolver.resolve("mrd_tenantkey1_too-short"), null);
    assert.equal(await resolver.resolve(`${token}x`), null);
    assert.equal(await createTenantPrincipalResolver(reader({ revokedAt: new Date() }), pepper).resolve(token), null);
    assert.equal(await createTenantPrincipalResolver(reader({ keyHash: apiKeyHash(`${token}x`, pepper) }), pepper).resolve(token), null);
    assert.doesNotMatch(JSON.stringify(principal), /abcdefghijklmnopqrstuvwxyz123456/u);
    assert.throws(
      () => createTenantPrincipalResolver(reader(), "too-short"),
      /MERIDIAN_API_KEY_PEPPER must be at least 32 characters/u
    );
    assert.throws(
      () => apiKeyHash(token, "too-short"),
      /MERIDIAN_API_KEY_PEPPER must be at least 32 characters/u
    );
  });

  void test("derives tenant identity on the server and rejects invalid credentials without trusting X-Tenant-ID", async () => {
    const resolver: TenantPrincipalResolver = {
      async resolve(supplied) {
        return supplied === token ? tenantPrincipal : null;
      },
    };
    const app = createApp({
      principalResolver: resolver,
      configure(testApp) {
        testApp.get("/api/principal-boundary", (request, response) => response.json(request.principal));
      },
    });

    await withServer(app, async (baseUrl) => {
      const accepted = await fetch(`${baseUrl}/api/principal-boundary`, {
        headers: { authorization: `Bearer ${token}`, "x-tenant-id": "attacker-controlled-tenant" },
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), tenantPrincipal);

      const rejected = await fetch(`${baseUrl}/api/principal-boundary`, {
        headers: { authorization: "Bearer wrong-key", "x-tenant-id": "tenant-auth-a" },
      });
      assert.equal(rejected.status, 401);
      const body = await rejected.json();
      assert.deepEqual(body, {
        type: "urn:meridian:problem:unauthorized",
        title: "Unauthorized",
        status: 401,
        code: "UNAUTHORIZED",
      });
      assert.doesNotMatch(JSON.stringify(body), /wrong-key|tenant-auth-a/u);
    });
  });

  void test("keeps the explicit legacy bridge while associating it with its configured tenant", async () => {
    const app = createApp({
      apiKey: "legacy-api-key",
      legacyTenantId: "tenant-legacy",
      configure(testApp) {
        testApp.get("/api/legacy-principal", (request, response) => response.json(request.principal));
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/legacy-principal`, {
        headers: { authorization: "Bearer legacy-api-key", "x-tenant-id": "ignored" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        tenantId: "tenant-legacy",
        subjectId: "legacy:meridian-api",
        credentialId: "legacy:meridian-api",
        kind: "LEGACY_API_KEY",
        role: "ADMIN",
      });
    });
  });

  void test("maps the non-production compatibility path to legacy-default instead of an unscoped principal", async () => {
    const app = createApp({
      configure(testApp) {
        testApp.get("/api/development-principal", (request, response) => response.json(request.principal));
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/development-principal`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        tenantId: "legacy-default",
        subjectId: "development:unauthenticated",
        credentialId: "development:unauthenticated",
        kind: "DEVELOPMENT",
        role: "ADMIN",
      });
    });
  });

  void test("allows production tenant-key startup only with a strong pepper", () => {
    assert.doesNotThrow(() => createApp({ environment: "production", apiKeyPepper: pepper }));
    assert.throws(
      () => createApp({ environment: "production", apiKeyPepper: "too-short" }),
      /MERIDIAN_API_KEY_PEPPER must be at least 32 characters/u
    );
  });
});
