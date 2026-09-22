import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { describe, test } from "node:test";
import { createApp } from "./app";
import type { Principal } from "./auth/principal";
import {
  createIdempotencyMiddleware,
  type IdempotencyRecord,
  type IdempotencyResponse,
  type IdempotencyReservation,
  type IdempotencyStore,
} from "./idempotency";

class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { record: IdempotencyRecord; response?: IdempotencyResponse }>();

  async reserve(record: IdempotencyRecord): Promise<IdempotencyReservation> {
    const key = [record.clientScope, record.method, record.route, record.idempotencyKey].join("/");
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, { record });
      return { kind: "reserved", id: key };
    }
    if (existing.record.requestFingerprint !== record.requestFingerprint) return { kind: "fingerprint-mismatch" };
    if (existing.response === undefined) return { kind: "in-progress" };
    return { kind: "completed", response: existing.response };
  }

  async complete(id: string, response: IdempotencyResponse): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) throw new Error("reservation disappeared");
    record.response = response;
  }
}

async function withServer<T>(
  app: ReturnType<typeof createApp>,
  operation: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function mutation(key: string, body: unknown, client = "test-client", token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "idempotency-client": client,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  };
}

const directTestPrincipal: Principal = {
  tenantId: "tenant-direct-test",
  subjectId: "tenant:tenant-direct-test",
  credentialId: "credential-direct-test",
  kind: "TENANT_API_KEY",
  role: "BILLING",
};

function attachDirectTestPrincipal(
  request: express.Request,
  _response: express.Response,
  next: express.NextFunction
): void {
  request.principal = directTestPrincipal;
  next();
}

void describe("durable idempotency HTTP boundary", () => {
  void test("replays the exact completed status, content type, and body without reapplying", async () => {
    const store = new InMemoryIdempotencyStore();
    let applies = 0;
    const app = createApp({
      idempotencyStore: store,
      configure(testApp) {
        testApp.post("/api/idempotency-test", (_request, response) => {
          applies += 1;
          response.setHeader("etag", '"receipt-r-1"');
          response.status(201).type("application/vnd.meridian.receipt+json").send('{"receipt":"r-1"}');
        });
      },
    });

    await withServer(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/idempotency-test`, mutation("receipt-1", { amount: "12.3400" }));
      const second = await fetch(`${baseUrl}/api/idempotency-test`, mutation("receipt-1", { amount: "12.3400" }));

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.equal(first.headers.get("content-type"), "application/vnd.meridian.receipt+json; charset=utf-8");
      assert.equal(second.headers.get("content-type"), first.headers.get("content-type"));
      assert.equal(first.headers.get("etag"), '"receipt-r-1"');
      assert.equal(second.headers.get("etag"), first.headers.get("etag"));
      assert.equal(await second.text(), await first.text());
      assert.equal(applies, 1);
    });
  });

  void test("rejects a changed request for the same scoped key, while routes and clients remain isolated", async () => {
    const store = new InMemoryIdempotencyStore();
    let applies = 0;
    const app = createApp({
      idempotencyStore: store,
      configure(testApp) {
        testApp.post("/api/idempotency-test", (_request, response) => {
          applies += 1;
          response.status(201).json({ applies });
        });
        testApp.post("/api/another-idempotency-test", (_request, response) => {
          applies += 1;
          response.status(201).json({ applies });
        });
      },
    });

    await withServer(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/idempotency-test`, mutation("shared-key", { amount: "1.0000" }));
      assert.equal(first.status, 201);

      const mismatch = await fetch(`${baseUrl}/api/idempotency-test`, mutation("shared-key", { amount: "2.0000" }));
      assert.equal(mismatch.status, 409);
      assert.deepEqual(await mismatch.json(), {
        type: "urn:meridian:problem:conflict",
        title: "Conflict",
        status: 409,
        code: "IDEMPOTENCY_KEY_REUSED",
        detail: "Idempotency-Key was used with a different request",
      });

      const differentClient = await fetch(
        `${baseUrl}/api/idempotency-test`,
        mutation("shared-key", { amount: "2.0000" }, "another-client")
      );
      const differentRoute = await fetch(
        `${baseUrl}/api/another-idempotency-test`,
        mutation("shared-key", { amount: "2.0000" })
      );
      assert.equal(differentClient.status, 201);
      assert.equal(differentRoute.status, 201);
      assert.equal(applies, 3);
    });
  });

  void test("fails closed while the first concurrent mutation is in progress", async () => {
    const store = new InMemoryIdempotencyStore();
    let applies = 0;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const app = createApp({
      idempotencyStore: store,
      configure(testApp) {
        testApp.post("/api/slow-idempotency-test", async (_request, response) => {
          applies += 1;
          handlerStarted?.();
          await released;
          response.status(202).json({ accepted: true });
        });
      },
    });

    await withServer(app, async (baseUrl) => {
      const first = fetch(`${baseUrl}/api/slow-idempotency-test`, mutation("race-key", { amount: "5.0000" }));
      await started;
      const concurrent = await fetch(`${baseUrl}/api/slow-idempotency-test`, mutation("race-key", { amount: "5.0000" }));
      assert.equal(concurrent.status, 409);
      assert.deepEqual(await concurrent.json(), {
        type: "urn:meridian:problem:conflict",
        title: "Conflict",
        status: 409,
        code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        detail: "An identical request is already being processed; retry later",
      });
      assert.equal(applies, 1);

      release?.();
      const completed = await first;
      assert.equal(completed.status, 202);
      const replay = await fetch(`${baseUrl}/api/slow-idempotency-test`, mutation("race-key", { amount: "5.0000" }));
      assert.equal(replay.status, 202);
      assert.equal(applies, 1);
    });
  });

  void test("leaves existing mutations unchanged when no idempotency key is supplied", async () => {
    const store = new InMemoryIdempotencyStore();
    let applies = 0;
    const app = createApp({
      idempotencyStore: store,
      configure(testApp) {
        testApp.post("/api/no-idempotency-test", (_request, response) => {
          applies += 1;
          response.status(201).json({ applies });
        });
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/no-idempotency-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: "1.0000" }),
      });
      assert.equal(response.status, 201);
      assert.equal(applies, 1);
    });
  });

  void test("isolates a reused key by the authenticated tenant and principal", async () => {
    const store = new InMemoryIdempotencyStore();
    let applies = 0;
    const app = createApp({
      idempotencyStore: store,
      principalResolver: {
        async resolve(token) {
          if (token !== "tenant-a-key" && token !== "tenant-b-key") return null;
          const tenantId = token === "tenant-a-key" ? "tenant-a" : "tenant-b";
          return {
            tenantId,
            subjectId: `tenant:${tenantId}`,
            credentialId: `credential:${tenantId}`,
            kind: "TENANT_API_KEY",
            role: "BILLING",
          };
        },
      },
      configure(testApp) {
        testApp.post("/api/tenant-idempotency-test", (_request, response) => {
          applies += 1;
          response.status(201).json({ applies });
        });
      },
    });

    await withServer(app, async (baseUrl) => {
      const firstA = await fetch(
        `${baseUrl}/api/tenant-idempotency-test`,
        mutation("same-key", { amount: "1.0000" }, "shared-client", "tenant-a-key")
      );
      const firstB = await fetch(
        `${baseUrl}/api/tenant-idempotency-test`,
        mutation("same-key", { amount: "1.0000" }, "shared-client", "tenant-b-key")
      );
      const replayA = await fetch(
        `${baseUrl}/api/v1/tenant-idempotency-test`,
        mutation("same-key", { amount: "1.0000" }, "shared-client", "tenant-a-key")
      );
      assert.deepEqual(await firstA.json(), { applies: 1 });
      assert.deepEqual(await firstB.json(), { applies: 2 });
      assert.deepEqual(await replayA.json(), { applies: 1 });
      assert.equal(applies, 2);
    });
  });

  void test("shares replay scope across the legacy and v1 aliases", async () => {
    const store = new InMemoryIdempotencyStore();
    const app = express();
    app.use(express.json());
    const idempotency = createIdempotencyMiddleware(store);
    let applies = 0;
    const handler = (_request: express.Request, response: express.Response) => {
      applies += 1;
      response.status(201).json({ applies });
    };
    app.post("/api/alias-test", attachDirectTestPrincipal, idempotency, handler);
    app.post("/api/v1/alias-test", attachDirectTestPrincipal, idempotency, handler);

    await withServer(app, async (baseUrl) => {
      const legacy = await fetch(
        `${baseUrl}/api/alias-test`,
        mutation("version-alias", { amount: "1.0000" })
      );
      const versioned = await fetch(
        `${baseUrl}/api/v1/alias-test`,
        mutation("version-alias", { amount: "1.0000" })
      );

      assert.equal(legacy.status, 201);
      assert.equal(versioned.status, 201);
      assert.equal(await versioned.text(), await legacy.text());
      assert.equal(applies, 1);
    });
  });
});
