/* oxlint-disable typescript/no-unsafe-type-assertion -- Express exposes route layers without a public typed inspection API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler } from "express";
import type { Principal } from "../auth/principal";
import { AuthorizationError } from "../errors";
import { orderOperations, ordersView } from "./ordersView";

const viewer: Principal = {
    subjectId: "viewer:order-viewer-operator",
  credentialId: "viewer-order-credential",
  kind: "OPERATOR_API_KEY",
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
  const layer = (ordersView as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method]
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (handler === undefined) throw new Error(`Order route ${path} is missing`);
  return handler;
}

async function invokeViewer(
  method: string,
  path: string,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  let received: unknown;
  handlerFor(method, path)(
    { params, query: {}, body, principal: viewer } as never,
    { status: () => ({ json: () => undefined }), json: () => undefined } as never,
    (error) => {
      received = error;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return received;
}

void test("VIEWER principals cannot create, update, or invoice orders", async () => {
  const errors = await Promise.all([
    invokeViewer("post", "/orders", {}, {
      customerId: "customer-1",
      items: [{ productId: "product-1", quantity: "1.000000" }],
    }),
    invokeViewer("patch", "/orders/:id", { id: "order-1" }, { notes: "Viewer cannot update" }),
    invokeViewer("post", "/orders/:id/invoice", { id: "order-1" }, undefined),
  ]);
  for (const error of errors) {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.problem.status, 403);
    assert.equal(error.problem.code, "FORBIDDEN");
  }
});

void test("order operation descriptors retain complete paths, conditional headers, and strict output schemas", () => {
  assert.deepEqual(
    orderOperations.map(({ method, path, operationId }) => `${method} ${path} ${operationId}`),
    [
      "get /orders listOrders",
      "get /orders/:id getOrder",
      "post /orders createOrder",
      "put /orders/:id replaceOrder",
      "patch /orders/:id updateOrder",
      "post /orders/:id/invoice createInvoiceForOrder",
    ]
  );
  const get = orderOperations[1];
  const put = orderOperations[3];
  const patch = orderOperations[4];
  assert.equal(put.deprecated, true);
  assert.match(put.description ?? "", /Deprecated.*Use PATCH/u);
  assert.notEqual(patch.deprecated, true);
  assert.equal(get.success.schema.safeParse({ id: "order-1", unexpected: true }).success, false);
  assert.ok("ETag" in get.responseHeaders.shape);
  assert.ok("ETag" in put.responseHeaders.shape);
  assert.ok("If-Match" in put.requestHeaders.shape);
  assert.ok("Idempotency-Key" in put.requestHeaders.shape);
  assert.ok("If-Match" in patch.requestHeaders.shape);
  assert.ok("Idempotency-Client" in patch.requestHeaders.shape);
  assert.equal(put.errors.includes(412), true);
  assert.equal(put.errors.includes(428), true);
  for (const operation of orderOperations) {
    assert.ok("X-Request-ID" in operation.responseHeaders.shape);
  }
});
