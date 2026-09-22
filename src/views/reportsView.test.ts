/* oxlint-disable typescript/no-unsafe-type-assertion -- Express exposes route layers without a public typed inspection API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidationErrorResponseSchema } from "@meridian/contracts";
import type { RequestHandler } from "express";
import type { Principal } from "../auth/principal";
import { AuthenticationError } from "../errors";
import { reportOperations, reportsView } from "./reportsView";

const viewer: Principal = {
  tenantId: "report-viewer-tenant",
  subjectId: "viewer:report-viewer-tenant",
  credentialId: "viewer-report-credential",
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

function handlerFor(path: string): RequestHandler {
  const layer = (reportsView as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods.get
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (handler === undefined) throw new Error(`Report route ${path} is missing`);
  return handler;
}

void test("report routes reject invalid periods at the mounted HTTP validation boundary", async () => {
  let status: number | undefined;
  let body: unknown;
  handlerFor("/reports/revenue-by-quarter")(
    {
      params: {},
      query: { from: "2026-12-31", to: "2026-01-01" },
      body: undefined,
      principal: viewer,
    } as never,
    {
      status: (value: number) => {
        status = value;
        return { json: (valueBody: unknown) => { body = valueBody; } };
      },
      json: (valueBody: unknown) => { body = valueBody; },
    } as never,
    () => undefined
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(status, 400);
  assert.equal(ValidationErrorResponseSchema.parse(body).code, "VALIDATION_ERROR");
});

void test("report operations retain tenant-read authorization and exact-decimal output contracts", async () => {
  let received: unknown;
  handlerFor("/reports/annual-revenue")(
    { params: {}, query: {}, body: undefined } as never,
    {} as never,
    (error) => { received = error; }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(received instanceof AuthenticationError);

  assert.deepEqual(
    reportOperations.map(({ method, path, operationId }) => `${method} ${path} ${operationId}`),
    [
      "get /reports/revenue-by-quarter revenueByQuarter",
      "get /reports/revenue-by-customer revenueByCustomer",
      "get /reports/annual-revenue annualRevenue",
    ]
  );
  assert.equal(
    reportOperations[0].success.schema.safeParse([
      { quarter: "2026-Q1", invoiceCount: 1, revenue: 0.1, revenueDecimal: "0.1000" },
    ]).success,
    true
  );
  assert.equal(
    reportOperations[0].success.schema.safeParse([
      { quarter: "2026-Q1", invoiceCount: 1, revenue: 0.1, revenueDecimal: "0.10000" },
    ]).success,
    false,
    "a report output cannot leak an out-of-scale decimal"
  );
  assert.equal(
    reportOperations[1].success.schema.safeParse([
      { customerId: "customer-1", customerName: "Customer", invoiceCount: 1.5, revenue: 1 },
    ]).success,
    false
  );
  for (const operation of reportOperations) {
    assert.ok("X-Request-ID" in operation.responseHeaders.shape);
  }
});
