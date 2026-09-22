/* oxlint-disable typescript/no-unsafe-type-assertion -- Express exposes route layers without a public typed inspection API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler } from "express";
import { Router } from "express";
import type { Principal } from "../auth/principal";
import { AuthorizationError } from "../errors";
import { ResponseContractViolationError, mountOperation } from "../openapi/operation";
import { invoiceOperations, invoicesView } from "./invoicesView";

const viewer: Principal = {
  tenantId: "invoice-viewer-tenant",
  subjectId: "viewer:invoice-viewer-tenant",
  credentialId: "viewer-invoice-credential",
  kind: "TENANT_API_KEY",
  role: "VIEWER",
};
const billing: Principal = { ...viewer, role: "BILLING" };

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: RequestHandler }[];
  };
};

function handlerFor(router: Router, method: string, path: string): RequestHandler {
  const layer = (router as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method]
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (handler === undefined) throw new Error(`Invoice route ${path} is missing`);
  return handler;
}

async function invoke(
  router: Router,
  method: string,
  path: string,
  principal: Principal,
  params: Record<string, string>,
  body: unknown
) {
  let received: unknown;
  let status: number | undefined;
  let json: unknown;
  const response = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      json = payload;
      return this;
    },
  };
  handlerFor(router, method, path)(
    { params, query: {}, body, principal } as never,
    response as never,
    (error) => {
      received = error;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { received, status, json };
}

void test("Invoice runtime routes reject viewers and malformed delivery requests before controller work", async () => {
  const forbidden = await Promise.all([
    invoke(invoicesView, "put", "/invoices/:id", viewer, { id: "invoice-1" }, { dueDate: "2030-01-01" }),
    invoke(invoicesView, "patch", "/invoices/:id", viewer, { id: "invoice-1" }, { dueDate: "2030-01-01" }),
    invoke(invoicesView, "post", "/invoices/:id/post", viewer, { id: "invoice-1" }, undefined),
    invoke(invoicesView, "post", "/invoices/:id/send", viewer, { id: "invoice-1" }, { method: "EMAIL" }),
    invoke(invoicesView, "post", "/invoices/transmissions/:transmissionId/refresh", viewer, { transmissionId: "transmission-1" }, undefined),
  ]);
  for (const result of forbidden) {
    assert.ok(result.received instanceof AuthorizationError);
    assert.equal(result.received.problem.status, 403);
  }

  const malformed = await invoke(
    invoicesView,
    "post",
    "/invoices/:id/send",
    billing,
    { id: "invoice-1" },
    { method: "FAX" }
  );
  assert.equal(malformed.received, undefined);
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.json, {
    error: "Request validation failed",
    code: "VALIDATION_ERROR",
    issues: [
      {
        code: "invalid_value",
        path: "body.method",
        message: "Invalid option: expected one of \"EMAIL\"|\"PORTAL\"|\"API\"",
      },
    ],
  });
});

void test("Invoice descriptor routes own full paths, headers, exact decimal output, and runtime output enforcement", async () => {
  assert.deepEqual(
    invoiceOperations.map(({ method, path, operationId }) => `${method} ${path} ${operationId}`),
    [
      "get /invoices listInvoices",
      "get /invoices/:id getInvoice",
      "put /invoices/:id replaceInvoice",
      "patch /invoices/:id updateInvoice",
      "post /invoices/:id/post postInvoice",
      "post /invoices/:id/send sendInvoice",
      "post /invoices/transmissions/:transmissionId/refresh refreshInvoiceTransmission",
    ]
  );
  const get = invoiceOperations[1];
  const replace = invoiceOperations[2];
  const patch = invoiceOperations[3];
  assert.equal(replace.deprecated, true);
  assert.match(replace.description ?? "", /Deprecated.*Use PATCH/u);
  assert.notEqual(patch.deprecated, true);
  assert.ok("ETag" in get.responseHeaders.shape);
  for (const conditional of [replace, patch]) {
    assert.ok("If-Match" in conditional.requestHeaders.shape);
    assert.ok("Idempotency-Key" in conditional.requestHeaders.shape);
    assert.equal(conditional.errors.includes(412), true);
    assert.equal(conditional.errors.includes(428), true);
  }
  for (const operation of invoiceOperations) assert.ok("X-Request-ID" in operation.responseHeaders.shape);
  for (const operation of invoiceOperations.filter(({ method }) => method !== "get")) {
    assert.ok("Idempotency-Key" in operation.requestHeaders.shape);
    assert.ok("Idempotency-Client" in operation.requestHeaders.shape);
  }
  assert.equal(
    get.success.schema.safeParse({
      id: "invoice-1",
      number: "INV-1",
      customerId: "customer-1",
      orderId: "order-1",
      status: "DRAFT",
      issueDate: "2030-01-01T00:00:00.000Z",
      dueDate: "2030-01-31T00:00:00.000Z",
      total: 1,
      amountPaid: 0,
      balance: 1,
      postedAt: null,
      lines: [],
      payments: [],
      transmissions: [],
      lastTransmission: null,
      totalDecimal: "1.0000",
      amountPaidDecimal: "0.0000",
      balanceDecimal: "1.0000",
    }).success,
    true
  );

  const outputRouter = Router();
  mountOperation(outputRouter, {
    ...invoiceOperations[0],
    path: "/invoice-output-contract",
    handler: async () => [{ id: "incomplete-invoice" }],
  });
  const result = await invoke(outputRouter, "get", "/invoice-output-contract", billing, {}, undefined);
  assert.ok(result.received instanceof ResponseContractViolationError);
});
