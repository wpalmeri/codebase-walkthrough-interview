/* oxlint-disable typescript/no-unsafe-type-assertion -- Express exposes route layers without a public typed inspection API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler } from "express";
import type { Principal } from "../auth/principal";
import { AuthorizationError } from "../errors";
import { paymentsView } from "./paymentsView";

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
    invokeViewer("/", {}, { customerId: "customer-1", amount: "1.0000" }),
    invokeViewer("/:id/apply", { id: "payment-1" }, {
      applications: [{ invoiceId: "invoice-1", amount: "1.0000" }],
    }),
    invokeViewer("/:id/applications/:applicationId/reversals", {
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
