/* oxlint-disable typescript/no-unsafe-type-assertion -- Express exposes route layers without a public typed inspection API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler } from "express";
import type { Principal } from "../auth/principal";
import { AuthorizationError } from "../errors";
import { paymentOperations, paymentsView } from "./paymentsView";

const viewer: Principal = {
  tenantId: "payment-viewer-tenant",
  subjectId: "viewer:payment-viewer-tenant",
  credentialId: "viewer-credential",
  kind: "TENANT_API_KEY",
  role: "VIEWER",
};

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: RequestHandler }[];
  };
};

function handlerFor(method: string, path: string): RequestHandler {
  const layer = (paymentsView as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method]
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (handler === undefined) throw new Error(`Payment route ${path} is missing`);
  return handler;
}

async function invokeViewer(path: string, params: Record<string, string>, body: unknown): Promise<unknown> {
  let received: unknown;
  handlerFor("post", path)(
    { params, query: {}, body, principal: viewer } as never,
    { status: () => ({ json: () => undefined }), json: () => undefined } as never,
    (error) => {
      received = error;
    }
  );
  // h() delegates rejected async handlers to next() after its promise chain settles.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return received;
}

void test("VIEWER principals cannot record, apply, or reverse payments", async () => {
  const errors = await Promise.all([
    invokeViewer("/payments", {}, { customerId: "customer-1", amount: "1.0000" }),
    invokeViewer("/payments/:id/apply", { id: "payment-1" }, {
      applications: [{ invoiceId: "invoice-1", amount: "1.0000" }],
    }),
    invokeViewer("/payments/:id/applications/:applicationId/reversals", {
      id: "payment-1",
      applicationId: "application-1",
    }, {
      amount: "1.0000",
      reason: "Viewer cannot reverse",
      accountingDate: "2026-10-31",
    }),
  ]);
  for (const error of errors) {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.problem.status, 403);
    assert.equal(error.problem.code, "FORBIDDEN");
  }
});

void test("payment operation descriptors validate both retained list shapes and document mutation boundaries", () => {
  assert.deepEqual(
    paymentOperations.map(({ method, path, operationId }) => `${method} ${path} ${operationId}`),
    [
      "get /payments listPayments",
      "get /payments/:id getPayment",
      "post /payments recordPayment",
      "post /payments/:id/applications/:applicationId/reversals reversePaymentApplication",
      "post /payments/:id/apply applyPayment",
    ]
  );
  const list = paymentOperations[0];
  assert.equal(list.success.schema.safeParse([]).success, true, "legacy remains an array response");
  assert.equal(
    list.success.schema.safeParse({ data: [], page: { limit: 50, nextCursor: null } }).success,
    true,
    "v1 returns the additive page envelope"
  );
  assert.equal(
    list.success.schema.safeParse({ data: [], page: { limit: 101, nextCursor: null } }).success,
    false,
    "runtime output validation retains the shared page bound"
  );

  for (const operation of paymentOperations) {
    assert.ok("X-Request-ID" in operation.responseHeaders.shape);
  }
  for (const operation of paymentOperations.filter(({ method }) => method === "post")) {
    assert.ok("Idempotency-Key" in operation.requestHeaders.shape);
    assert.ok("Idempotency-Client" in operation.requestHeaders.shape);
  }
  assert.equal(paymentOperations[3].success.status, 201);
  assert.deepEqual(paymentOperations[3].errors, [400, 401, 403, 404, 409, 412, 422, 500, 413]);
});
