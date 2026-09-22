import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createV1Client, parseNextLink, type V1Fetch } from "./v1Api";

const jsonHeaders = { "content-type": "application/json" };

const invoiceResponse = {
  id: "invoice/id",
  number: "INV-001",
  customerId: "customer-1",
  orderId: "order-1",
  status: "DRAFT",
  issueDate: "2026-10-01T00:00:00.000Z",
  dueDate: "2026-10-31T00:00:00.000Z",
  total: 0,
  amountPaid: 0,
  balance: 0,
  postedAt: null,
  lines: [],
  payments: [],
  transmissions: [],
  lastTransmission: null,
} as const;

const customerPageResponse = {
  data: [
    {
      id: "customer-1",
      name: "Customer",
      email: "customer@example.test",
      billingAddress: null,
      portalAccount: null,
      clearinghouseId: null,
    },
  ],
  page: { limit: 25, nextCursor: null },
} as const;

const paymentReversalResponse = {
  id: "reversal-1",
  paymentApplicationId: "application-1",
  amount: 12.5,
  amountDecimal: "12.5000",
  reason: "Correction",
  accountingDate: "2026-10-01",
  actor: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
} as const;

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

void describe("contract-derived v1 client", () => {
  void test("encodes path/query values, omits undefined query values, and sends JSON only for a body", async () => {
    let calls = 0;
    let receivedUrl: string | undefined;
    let receivedInit: RequestInit | undefined;
    const fetch: V1Fetch = async (input, init) => {
      calls += 1;
      receivedUrl = inputUrl(input);
      receivedInit = init;
      return new Response(JSON.stringify(inputUrl(input).includes("/customers") ? customerPageResponse : invoiceResponse), {
        headers: {
          ...jsonHeaders,
          ETag: '"invoice:2"',
          "X-Request-ID": "request-123",
          Link: '</api/v1/invoices?cursor=next>; rel="next"; title="cursor, next", </api/v1/invoices?cursor=old>; rel="prev"',
        },
      });
    };
    const client = createV1Client({ fetch });

    const result = await client.request("/invoices/{id}", "get", {
      params: { path: { id: "invoice/id and space" } },
    });

    assert.equal(calls, 1);
    assert.equal(receivedUrl, "/api/v1/invoices/invoice%2Fid%20and%20space");
    assert.equal(receivedInit?.method, "GET");
    assert.equal(new Headers(receivedInit?.headers).get("content-type"), null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 200);
      assert.equal(result.data.id, "invoice/id");
      assert.equal(result.headers.get("etag"), '"invoice:2"');
      assert.equal(result.etag, '"invoice:2"');
      assert.equal(result.requestId, "request-123");
      assert.match(result.link ?? "", /title="cursor, next"/u);
      assert.equal(result.nextLink, "/api/v1/invoices?cursor=next");
    }

    calls = 0;
    const list = await client.request("/customers", "get", {
      params: { query: { cursor: "a b/c", limit: undefined } },
    });
    assert.equal(calls, 1);
    assert.equal(receivedUrl, "/api/v1/customers?cursor=a+b%2Fc");
    assert.equal(list.ok, true);
  });

  void test("serializes contract JSON body and typed request headers", async () => {
    let calls = 0;
    let receivedInit: RequestInit | undefined;
    const fetch: V1Fetch = async (_input, init) => {
      calls += 1;
      receivedInit = init;
      return new Response(JSON.stringify(invoiceResponse), { headers: jsonHeaders });
    };
    const client = createV1Client({ baseUrl: "https://example.test/api/v1/", fetch });

    const result = await client.request("/invoices/{id}", "put", {
      params: {
        path: { id: "invoice-1" },
        header: { "If-Match": '"invoice:1"', "X-Request-ID": "client-request" },
      },
      body: { dueDate: "2026-10-31" },
    });

    assert.equal(calls, 1);
    assert.equal(receivedInit?.method, "PUT");
    assert.equal(new Headers(receivedInit?.headers).get("content-type"), "application/json");
    assert.equal(new Headers(receivedInit?.headers).get("if-match"), '"invoice:1"');
    assert.equal(receivedInit?.body, '{"dueDate":"2026-10-31"}');
    assert.equal(result.ok, true);
  });

  void test("returns Problem Details and legacy validation failures as distinct errors", async () => {
    const problemClient = createV1Client({
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "urn:meridian:problem:forbidden",
            title: "Forbidden",
            status: 403,
            code: "FORBIDDEN",
          }),
          // Gateways occasionally rewrite this header; envelope recognition is structural.
          { status: 403, headers: { "content-type": "text/plain", "x-request-id": "p-1" } },
        ),
    });
    const problem = await problemClient.request("/invoices", "get");
    assert.equal(problem.ok, false);
    if (!problem.ok) {
      assert.equal(problem.error.kind, "problem");
      if (problem.error.kind === "problem") {
        assert.equal(problem.error.problem.code, "FORBIDDEN");
        assert.equal(problem.error.requestId, "p-1");
      }
    }

    const validationClient = createV1Client({
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: "VALIDATION_ERROR",
            error: "Request validation failed",
            issues: [{ code: "invalid_type", message: "cursor is invalid", path: "cursor" }],
          }),
          // A missing content type must not hide a valid legacy validation body.
          { status: 400 },
        ),
    });
    const validation = await validationClient.request("/customers", "get");
    assert.equal(validation.ok, false);
    if (!validation.ok) {
      assert.equal(validation.error.kind, "validation");
      if (validation.error.kind === "validation") assert.equal(validation.error.validation.issues.length, 1);
    }
  });

  void test("contains malformed and non-JSON protocol failures without exposing response bodies", async () => {
    const scenarios = [
      { status: 200, type: "application/json", body: "{", phase: "success", reason: "malformed-json-success" },
      { status: 200, type: "text/plain", body: "secret successful body", phase: "success", reason: "non-json-success" },
      { status: 500, type: "application/problem+json", body: "{", phase: "error", reason: "malformed-json-error" },
      { status: 500, type: "text/plain", body: "secret upstream diagnostic", phase: "error", reason: "non-json-error" },
    ] as const;

    for (const scenario of scenarios) {
      let calls = 0;
      const client = createV1Client({
        fetch: async () => {
          calls += 1;
          return new Response(scenario.body, { status: scenario.status, headers: { "content-type": scenario.type } });
        },
      });
      const result = await client.request("/customers", "get");
      assert.equal(calls, 1);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.kind, "protocol");
        if (result.error.kind === "protocol") {
          assert.equal(result.error.phase, scenario.phase);
          assert.equal(result.error.reason, scenario.reason);
        }
        assert.equal(JSON.stringify(result).includes("secret"), false);
      }
    }
  });

  void test("does not expose an incomplete JSON representation as a typed success", async () => {
    const client = createV1Client({
      fetch: async () => new Response(JSON.stringify({ id: "invoice-only" }), { headers: jsonHeaders }),
    });
    const result = await client.request("/invoices/{id}", "get", { params: { path: { id: "invoice-only" } } });
    assert.equal(result.ok, false);
    if (!result.ok && result.error.kind === "protocol") {
      assert.equal(result.error.reason, "invalid-success");
      assert.equal(result.error.requestId, null);
    } else {
      assert.fail("expected an invalid-success protocol failure");
    }
  });

  void test("returns Zod's validated output rather than raw JSON", async () => {
    const client = createV1Client({
      fetch: async () =>
        new Response(JSON.stringify({ ...invoiceResponse, unexpectedGatewayField: "do not expose" }), {
          headers: jsonHeaders,
        }),
    });
    const result = await client.request("/invoices/{id}", "get", { params: { path: { id: "invoice-1" } } });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(Object.hasOwn(result.data, "unexpectedGatewayField"), false);
  });

  void test("accepts the generated 201 success status and rejects undocumented 2xx statuses", async () => {
    const created = createV1Client({
      fetch: async () => new Response(JSON.stringify(paymentReversalResponse), { status: 201, headers: jsonHeaders }),
    });
    const accepted = await created.request("/payments/{id}/applications/{applicationId}/reversals", "post", {
      params: { path: { id: "payment-1", applicationId: "application-1" } },
      body: { amount: 12.5, reason: "Correction", accountingDate: "2026-10-01" },
    });
    assert.equal(accepted.ok, true);
    if (accepted.ok) assert.equal(accepted.status, 201);

    for (const response of [
      new Response(JSON.stringify(invoiceResponse), { status: 299, headers: jsonHeaders }),
      new Response(null, { status: 204, headers: jsonHeaders }),
    ]) {
      const client = createV1Client({ fetch: async () => response });
      const result = await client.request("/invoices/{id}", "get", { params: { path: { id: "invoice-1" } } });
      assert.equal(result.ok, false);
      if (!result.ok && result.error.kind === "protocol") {
        assert.equal(result.error.reason, "unexpected-success-status");
      } else {
        assert.fail("expected unexpected-success-status protocol failure");
      }
    }
  });

  void test("passes AbortSignal to fetch and normalizes aborts without exposing transport errors", async () => {
    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | null | undefined;
    const client = createV1Client({
      fetch: async (_input, init) => {
        receivedSignal = init?.signal;
        throw new DOMException("private transport detail", "AbortError");
      },
    });
    const result = await client.request("/customers", "get", { signal: controller.signal });
    assert.equal(receivedSignal, controller.signal);
    assert.deepEqual(result, { ok: false, error: { kind: "aborted", message: "Request aborted" } });
  });

  void test("rejects undocumented error statuses and Problem Details status mismatches", async () => {
    const mismatchedProblem = JSON.stringify({
      type: "urn:meridian:problem:forbidden",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
    });
    const mismatchClient = createV1Client({
      fetch: async () => new Response(mismatchedProblem, { status: 500, headers: { "content-type": "application/problem+json" } }),
    });
    const mismatch = await mismatchClient.request("/customers", "get");
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok && mismatch.error.kind === "protocol") {
      assert.equal(mismatch.error.reason, "problem-status-mismatch");
    } else {
      assert.fail("expected problem-status-mismatch protocol failure");
    }

    const undocumentedClient = createV1Client({
      fetch: async () => new Response(mismatchedProblem, { status: 418, headers: { "content-type": "application/problem+json" } }),
    });
    const undocumented = await undocumentedClient.request("/customers", "get");
    assert.equal(undocumented.ok, false);
    if (!undocumented.ok && undocumented.error.kind === "protocol") {
      assert.equal(undocumented.error.reason, "unexpected-error-status");
    } else {
      assert.fail("expected unexpected-error-status protocol failure");
    }
  });

  void test("fails malformed base URLs and missing template values locally before fetch", async () => {
    let calls = 0;
    const fetch: V1Fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(customerPageResponse), { headers: jsonHeaders });
    };
    const invalidBase = createV1Client({ baseUrl: "/api/v1/?debug=true", fetch });
    const invalidBaseResult = await invalidBase.request("/customers", "get");
    assert.deepEqual(invalidBaseResult, { ok: false, error: { kind: "request", reason: "invalid-base-url" } });
    const trailingSlashes = createV1Client({ baseUrl: "/api/v1//", fetch });
    const trailingSlashesResult = await trailingSlashes.request("/customers", "get");
    assert.deepEqual(trailingSlashesResult, { ok: false, error: { kind: "request", reason: "invalid-base-url" } });

    const client = createV1Client({ fetch });
    const malformedCall = Reflect.apply(client.request.bind(client), undefined, ["/invoices/{id}", "get", {}]);
    assert.equal(typeof malformedCall, "object");
    const missingPathResult = await Promise.resolve(malformedCall);
    assert.equal(calls, 0);
    if (
      typeof missingPathResult === "object" &&
      missingPathResult !== null &&
      "ok" in missingPathResult &&
      missingPathResult.ok === false &&
      "error" in missingPathResult &&
      typeof missingPathResult.error === "object" &&
      missingPathResult.error !== null &&
      "kind" in missingPathResult.error
    ) {
      assert.equal(missingPathResult.error.kind, "request");
    } else {
      assert.fail("expected a local missing-path-parameter error");
    }
  });

  void test("parses an RFC Link next relation without losing the raw header", () => {
    assert.equal(
      parseNextLink('</items?page=2>; title="page, two"; rel="previous next", </items?page=3>; rel="last"'),
      "/items?page=2",
    );
    assert.equal(parseNextLink('</items?page=1>; rel="prev"'), null);
  });
});

// Compile-time contract tests. These calls are not executed, but keep invalid
// route/method/parameter/body combinations from becoming public client APIs.
async function compileTimeContractChecks(client: ReturnType<typeof createV1Client>): Promise<void> {
  // @ts-expect-error /customers is read-only in the generated v1 contract.
  void client.request("/customers", "post");
  // @ts-expect-error templated paths require every generated path parameter.
  void client.request("/invoices/{id}", "get");
  // @ts-expect-error query parameter names are contract-derived.
  void client.request("/customers", "get", { params: { query: { unknown: "value" } } });
  // @ts-expect-error header parameter names are contract-derived.
  void client.request("/customers", "get", { params: { header: { Unexpected: "value" } } });
  // @ts-expect-error conditional writes require the generated If-Match header.
  void client.request("/invoices/{id}", "put", { params: { path: { id: "invoice-1" } }, body: {} });
  void client.request("/invoices/{id}", "put", {
    params: { path: { id: "invoice-1" }, header: { "If-Match": '"invoice:1"' } },
    // @ts-expect-error JSON bodies are contract-derived, not arbitrary caller data.
    body: { dueDate: 123 },
  });
  // @ts-expect-error v1 collection results are pages, not legacy arrays.
  const legacyArray: readonly unknown[] = (await client.request("/customers", "get")).data;
  void legacyArray;
  // @ts-expect-error request has no caller-controlled response generic.
  void client.request<readonly unknown[]>("/customers", "get");
}
void compileTimeContractChecks;
