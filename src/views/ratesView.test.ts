/* oxlint-disable typescript/no-unsafe-type-assertion -- Express exposes route layers without a public typed inspection API. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler } from "express";
import type { Principal } from "../auth/principal";
import { AuthorizationError } from "../errors";
import { rateOperations, ratesView } from "./ratesView";

const viewer: Principal = {
    subjectId: "viewer:rate-viewer-operator",
  credentialId: "viewer-rate-credential",
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
  const layer = (ratesView as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method]
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (handler === undefined) throw new Error(`Rate route ${path} is missing`);
  return handler;
}

async function invoke(
  method: string,
  principal: Principal,
  body: unknown,
  headers: Record<string, string> = {}
) {
  let received: unknown;
  let status: number | undefined;
  let json: unknown;
  handlerFor(method, "/rates/:id")(
    {
      params: { id: "rate-1" },
      query: {},
      body,
      principal,
      get: (header: string) => headers[header.toLowerCase()],
    } as never,
    {
      headersSent: false,
      setHeader: () => undefined,
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        json = payload;
        return this;
      },
    } as never,
    (error) => {
      received = error;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { received, status, json };
}

void test("Rate PATCH keeps the existing write authorization and requires unitPrice", async () => {
  const forbidden = await invoke("patch", viewer, { unitPrice: "10.0000" }, { "if-match": "etag" });
  assert.ok(forbidden.received instanceof AuthorizationError);
  assert.equal(forbidden.received.problem.status, 403);

  const invalid = await invoke(
    "patch",
    { ...viewer, role: "ADMIN" },
    {},
    { "if-match": "etag" }
  );
  assert.equal(invalid.received, undefined);
  assert.equal(invalid.status, 400);
  assert.equal(
    (invalid.json as { issues?: { path?: string }[] }).issues?.some(({ path }) => path === "body.unitPrice"),
    true
  );
});

void test("rate operation descriptors preserve legacy PUT while publishing PATCH as the preferred conditional update", () => {
  assert.deepEqual(
    rateOperations.map(({ method, path, operationId }) => `${method} ${path} ${operationId}`),
    [
      "get /rates listRates",
      "get /rates/combos listComboDiscounts",
      "post /rates/combos createComboDiscount",
      "get /rates/:id getRate",
      "put /rates/:id updateRate",
      "patch /rates/:id patchRate",
    ]
  );
  const put = rateOperations[4];
  const patch = rateOperations[5];
  assert.equal(put.deprecated, true);
  assert.match(put.description ?? "", /Use PATCH/u);
  assert.notEqual(patch.deprecated, true);
  for (const operation of [put, patch]) {
    assert.ok("If-Match" in operation.requestHeaders.shape);
    assert.ok("Idempotency-Key" in operation.requestHeaders.shape);
    assert.ok("ETag" in operation.responseHeaders.shape);
    assert.equal(operation.request.shape.body.safeParse({ unitPrice: "10.0000" }).success, true);
    assert.equal(operation.request.shape.body.safeParse({ tiers: [] }).success, false);
  }
});
