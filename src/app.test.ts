import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import type { Server } from "node:http";
import {
  ConflictError,
  DomainInvariantError,
  PreconditionError,
  ProblemDetailsSchema,
} from "./errors";
import { createApp } from "./app";
import { h } from "./views/helpers";

async function requestApp(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit
): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly link: string | null;
  readonly body: unknown;
}> {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      link: response.headers.get("link"),
      body: await response.json(),
    };
  } finally {
    await close(server);
  }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

void describe("HTTP problem-details boundary", () => {
  void test("maps an async Prisma-shaped not-found failure without leaking its message", async () => {
    const app = createApp({
      configure(testApp) {
        testApp.get(
          "/test/prisma-not-found",
          h(async () => {
            throw Object.assign(new Error("SELECT customer_email FROM private_table"), { code: "P2025" });
          })
        );
      },
    });
    const response = await requestApp(app, "/test/prisma-not-found");
    assert.equal(response.status, 404);
    assert.equal(response.contentType, "application/problem+json; charset=utf-8");
    assert.deepEqual(response.body, {
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  void test("maps a typed async conflict to a safe, stable client problem", async () => {
    const app = createApp({
      configure(testApp) {
        testApp.get(
          "/test/conflict",
          h(async () => {
            throw new ConflictError("VERSION_CONFLICT", "The record changed; reload and retry.");
          })
        );
      },
    });
    const response = await requestApp(app, "/test/conflict");
    assert.deepEqual(response.body, {
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "VERSION_CONFLICT",
      detail: "The record changed; reload and retry.",
    });
    assert.equal(ProblemDetailsSchema.safeParse(response.body).success, true);
  });

  void test("maps domain and precondition failures to their stable HTTP statuses", async () => {
    const app = createApp({
      configure(testApp) {
        testApp.get(
          "/test/domain",
          h(async () => {
            throw new DomainInvariantError(
              "PAYMENT_ALLOCATION_INVALID",
              "The payment cannot be allocated in its current state."
            );
          })
        );
        testApp.get(
          "/test/precondition",
          h(async () => {
            throw new PreconditionError(
              "ORDER_PRICING_BACKFILL_REQUIRED",
              "Historical pricing must be backfilled before this order can change."
            );
          })
        );
      },
    });

    const [domain, precondition] = await Promise.all([
      requestApp(app, "/test/domain"),
      requestApp(app, "/test/precondition"),
    ]);
    assert.equal(domain.status, 422);
    assert.deepEqual(domain.body, {
      type: "urn:meridian:problem:domain-invariant",
      title: "Unprocessable Entity",
      status: 422,
      code: "PAYMENT_ALLOCATION_INVALID",
      detail: "The payment cannot be allocated in its current state.",
    });
    assert.equal(precondition.status, 412);
    assert.deepEqual(precondition.body, {
      type: "urn:meridian:problem:precondition-failed",
      title: "Precondition Failed",
      status: 412,
      code: "ORDER_PRICING_BACKFILL_REQUIRED",
      detail: "Historical pricing must be backfilled before this order can change.",
    });
  });

  void test("maps database relation and constraint failures without exposing internals", async () => {
    const expected = [
      ["P2003", 422, "RELATED_RESOURCE_NOT_FOUND"],
      ["P2004", 422, "DATABASE_CONSTRAINT"],
      ["P2011", 422, "DATABASE_CONSTRAINT"],
      ["P2014", 409, "RELATION_CONFLICT"],
    ] as const;
    const app = createApp({
      configure(testApp) {
        for (const [code] of expected) {
          testApp.get(
            `/test/prisma/${code}`,
            h(async () => {
              throw Object.assign(new Error("constraint failed for secret@example.com"), {
                code,
                meta: { field: "customer_email", value: "secret@example.com" },
              });
            })
          );
        }
      },
    });

    for (const [code, status, problemCode] of expected) {
      const response = await requestApp(app, `/test/prisma/${code}`);
      assert.equal(response.status, status);
      assert.ok(isRecord(response.body));
      assert.equal(response.body.code, problemCode);
      assert.equal(response.body.status, status);
      assert.equal(ProblemDetailsSchema.safeParse(response.body).success, true);
      assert.doesNotMatch(JSON.stringify(response.body), /secret|customer_email/);
    }
  });

  void test("keeps unexpected async failures redacted and logs only through the injected sink", async () => {
    const logged: unknown[] = [];
    const app = createApp({
      logError(error) {
        logged.push(error);
      },
      configure(testApp) {
        testApp.get(
          "/test/unexpected",
          h(async () => {
            throw new Error("token=super-secret-value");
          })
        );
      },
    });
    const response = await requestApp(app, "/test/unexpected");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      type: "urn:meridian:problem:internal-error",
      title: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
    });
    assert.equal(logged.length, 1);
    assert.ok(logged[0] instanceof Error);
    assert.match(logged[0].message, /super-secret-value/);
    assert.doesNotMatch(JSON.stringify(response.body), /super-secret-value/);
  });

  void test("preserves the existing request-validation body and handles malformed JSON separately", async () => {
    const validation = await requestApp(createApp(), "/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "", amount: 1 }),
    });
    assert.equal(validation.status, 400);
    assert.ok(isRecord(validation.body));
    assert.deepEqual(Object.keys(validation.body).toSorted(), ["code", "error", "issues"]);
    assert.equal(validation.body.code, "VALIDATION_ERROR");

    const malformed = await requestApp(createApp(), "/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid JSON",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body, {
      type: "urn:meridian:problem:invalid-json",
      title: "Malformed JSON request body",
      status: 400,
      code: "INVALID_JSON",
    });
  });

  void test("returns a stable problem for an unknown route", async () => {
    const response = await requestApp(createApp(), "/api/no-such-route");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  void test("serves the additive v1 API while preserving a successor link on legacy routes", async () => {
    const invalidPayment = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "", amount: 1 }),
    };
    const [legacy, versioned] = await Promise.all([
      requestApp(createApp(), "/api/payments", invalidPayment),
      requestApp(createApp(), "/api/v1/payments", invalidPayment),
    ]);

    assert.equal(legacy.status, 400);
    assert.equal(versioned.status, 400);
    assert.deepEqual(versioned.body, legacy.body);
    assert.equal(legacy.link, '</api/v1>; rel="successor-version"');
    assert.equal(versioned.link, null);
  });

  void test("requires a constant-time bearer API key when configured", async () => {
    const app = createApp({ apiKey: "test-api-key" });
    const missing = await requestApp(app, "/api/payments");
    const wrong = await requestApp(app, "/api/payments", {
      headers: { authorization: "Bearer wrong-key" },
    });
    const accepted = await requestApp(app, "/api/payments", {
      method: "POST",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ customerId: "", amount: 1 }),
    });

    for (const response of [missing, wrong]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, {
        type: "urn:meridian:problem:unauthorized",
        title: "Unauthorized",
        status: 401,
        code: "UNAUTHORIZED",
      });
    }
    assert.equal(accepted.status, 400);
    assert.ok(isRecord(accepted.body));
    assert.equal(accepted.body.code, "VALIDATION_ERROR");
  });

  void test("refuses to start production without an API key", () => {
    assert.throws(
      () => createApp({ environment: "production", apiKey: "" }),
      /MERIDIAN_API_KEY is required/
    );
  });
});
