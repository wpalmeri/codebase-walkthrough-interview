import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { createOpenApiV1Document } from "./document";
import { customerOperations } from "../views/customersView";
import { orderOperations } from "../views/ordersView";
import { paymentOperations } from "../views/paymentsView";
import { productOperations } from "../views/productsView";
import { rateOperations } from "../views/ratesView";

const documentedOperations = [
  ...customerOperations,
  ...productOperations,
  ...rateOperations,
  ...orderOperations,
  ...paymentOperations,
] as const;

const OperationSchema = z.object({
  operationId: z.string(),
  summary: z.string(),
  security: z.array(z.object({ tenantBearer: z.array(z.never()) })),
  parameters: z.array(z.object({ name: z.string(), in: z.string(), required: z.boolean().optional() })),
  responses: z.record(z.string(), z.unknown()),
});

function operation(document: unknown, path: string, method: string) {
  const parsed = z
    .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
    .parse(document);
  return OperationSchema.parse(parsed.paths[path]?.[method]);
}

void describe("generated version-one OpenAPI contract", () => {
  void test("is deterministic and inventories the exact mounted catalog, rate, order, and payment operations", () => {
    const first = createOpenApiV1Document(documentedOperations);
    const second = createOpenApiV1Document(documentedOperations);
    assert.deepEqual(first, second);

    const document = z
      .object({
        openapi: z.literal("3.1.0"),
        servers: z.array(z.object({ url: z.literal("/api/v1") })),
        paths: z.record(z.string(), z.record(z.string(), z.unknown())),
      })
      .parse(first);
    assert.deepEqual(
      Object.entries(document.paths)
        .flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`))
        .toSorted(),
      [
        "get /customers",
        "get /orders",
        "get /orders/{id}",
        "get /products",
        "get /payments",
        "get /payments/{id}",
        "get /rates",
        "get /rates/combos",
        "get /rates/{id}",
        "patch /orders/{id}",
        "post /orders",
        "post /orders/{id}/invoice",
        "post /rates/combos",
        "post /payments",
        "post /payments/{id}/apply",
        "post /payments/{id}/applications/{applicationId}/reversals",
        "put /rates/{id}",
        "put /orders/{id}",
      ].toSorted()
    );
    assert.doesNotThrow(() => createOpenApiV1Document(documentedOperations));
    assert.throws(
      () => createOpenApiV1Document([...documentedOperations, customerOperations[0]]),
      /Duplicate OpenAPI operation/u
    );
  });

  void test("documents tenant bearer security, correlation, replay, and rate conditional headers", () => {
    const document = createOpenApiV1Document(documentedOperations);
    const customers = operation(document, "/customers", "get");
    const products = operation(document, "/products", "get");
    const getRate = operation(document, "/rates/{id}", "get");
    const updateRate = operation(document, "/rates/{id}", "put");
    const createCombo = operation(document, "/rates/combos", "post");

    assert.deepEqual(customers.security, [{ tenantBearer: [] }]);
    assert.deepEqual(products.security, [{ tenantBearer: [] }]);
    assert.equal(customers.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"), true);
    assert.equal(products.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"), true);
    assert.deepEqual(getRate.security, [{ tenantBearer: [] }]);
    assert.equal(getRate.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"), true);
    assert.equal(updateRate.parameters.some((parameter) => parameter.name === "If-Match" && parameter.required === true), true);
    assert.equal(updateRate.parameters.some((parameter) => parameter.name === "Idempotency-Key"), true);
    assert.equal(createCombo.parameters.some((parameter) => parameter.name === "Idempotency-Key"), true);

    const parsed = z
      .object({
        paths: z.object({
          "/rates/{id}": z.object({
            get: z.object({ responses: z.record(z.string(), z.unknown()) }),
            put: z.object({ responses: z.record(z.string(), z.unknown()), description: z.string() }),
          }),
        }),
      })
      .parse(document);
    const getSuccess = z.object({ headers: z.object({ ETag: z.unknown() }) }).parse(parsed.paths["/rates/{id}"].get.responses["200"]);
    const putSuccess = z.object({ headers: z.object({ ETag: z.unknown() }) }).parse(parsed.paths["/rates/{id}"].put.responses["200"]);
    assert.ok(getSuccess.headers.ETag);
    assert.ok(putSuccess.headers.ETag);
    assert.match(parsed.paths["/rates/{id}"].put.description, /mutable commercial terms|If-Match/u);

    const badRequest = z
      .object({ content: z.record(z.string(), z.unknown()) })
      .parse(parsed.paths["/rates/{id}"].put.responses["400"]);
    assert.equal("application/json" in badRequest.content, true);
    assert.equal("application/problem+json" in badRequest.content, true);
  });

  void test("documents payment pagination, bodies, replay headers, statuses, and public error contracts", () => {
    const document = createOpenApiV1Document(documentedOperations);
    const list = operation(document, "/payments", "get");
    const record = operation(document, "/payments", "post");
    const apply = operation(document, "/payments/{id}/apply", "post");
    const reverse = operation(document, "/payments/{id}/applications/{applicationId}/reversals", "post");

    for (const paymentOperation of [list, record, apply, reverse]) {
      assert.deepEqual(paymentOperation.security, [{ tenantBearer: [] }]);
      assert.equal(
        paymentOperation.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"),
        true
      );
    }
    for (const mutation of [record, apply, reverse]) {
      assert.equal(mutation.parameters.some((parameter) => parameter.name === "Idempotency-Key"), true);
      assert.equal(mutation.parameters.some((parameter) => parameter.name === "Idempotency-Client"), true);
    }
    assert.equal(list.parameters.some((parameter) => parameter.name === "limit" && parameter.in === "query"), true);
    assert.equal(list.parameters.some((parameter) => parameter.name === "cursor" && parameter.in === "query"), true);
    assert.equal(list.parameters.some((parameter) => parameter.name === "customerId" && parameter.in === "query"), true);

    const paths = z
      .object({
        paths: z.object({
          "/payments": z.object({
            get: z.object({ responses: z.record(z.string(), z.unknown()) }),
            post: z.object({ requestBody: z.unknown(), responses: z.record(z.string(), z.unknown()) }),
          }),
          "/payments/{id}/apply": z.object({
            post: z.object({ requestBody: z.unknown(), responses: z.record(z.string(), z.unknown()) }),
          }),
          "/payments/{id}/applications/{applicationId}/reversals": z.object({
            post: z.object({ requestBody: z.unknown(), responses: z.record(z.string(), z.unknown()) }),
          }),
        }),
    })
      .parse(document).paths;
    const listResponse = JSON.stringify(paths["/payments"].get.responses["200"]);
    assert.match(listResponse, /nextCursor|PageMetadata/u);
    assert.match(listResponse, /receivedAt/u);
    assert.doesNotMatch(
      listResponse,
      /oneOf/u,
      "the v1 document must not advertise the retained legacy array as an alternative top-level shape"
    );
    assert.match(JSON.stringify(paths["/payments"].post.requestBody), /customerId/u);
    assert.match(JSON.stringify(paths["/payments"].post.requestBody), /amount/u);
    assert.match(JSON.stringify(paths["/payments/{id}/apply"].post.requestBody), /applications/u);
    assert.match(JSON.stringify(paths["/payments/{id}/applications/{applicationId}/reversals"].post.requestBody), /accountingDate/u);
    assert.equal("200" in paths["/payments"].post.responses, true);
    assert.equal("201" in paths["/payments/{id}/applications/{applicationId}/reversals"].post.responses, true);
    for (const response of [
      paths["/payments"].get.responses["200"],
      paths["/payments"].post.responses["200"],
      paths["/payments/{id}/apply"].post.responses["200"],
      paths["/payments/{id}/applications/{applicationId}/reversals"].post.responses["201"],
    ]) {
      const parsedResponse = z
        .object({ headers: z.record(z.string(), z.unknown()) })
        .parse(response);
      assert.ok(parsedResponse.headers["X-Request-ID"]);
    }
    for (const responses of [
      paths["/payments"].post.responses,
      paths["/payments/{id}/apply"].post.responses,
      paths["/payments/{id}/applications/{applicationId}/reversals"].post.responses,
    ]) {
      assert.equal("400" in responses, true);
      assert.equal("401" in responses, true);
      assert.equal("403" in responses, true);
      assert.equal("404" in responses, true);
      assert.equal("application/problem+json" in z.object({ content: z.record(z.string(), z.unknown()) }).parse(responses["404"]).content, true);
    }
  });

  void test("documents Order representations, v1 ETags, conditional writes, invoice creation, and errors", () => {
    const document = createOpenApiV1Document(documentedOperations);
    const list = operation(document, "/orders", "get");
    const get = operation(document, "/orders/{id}", "get");
    const create = operation(document, "/orders", "post");
    const put = operation(document, "/orders/{id}", "put");
    const patch = operation(document, "/orders/{id}", "patch");
    const invoice = operation(document, "/orders/{id}/invoice", "post");
    for (const orderOperation of [list, get, create, put, patch, invoice]) {
      assert.deepEqual(orderOperation.security, [{ tenantBearer: [] }]);
      assert.equal(
        orderOperation.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"),
        true
      );
    }
    for (const mutation of [create, put, patch, invoice]) {
      assert.equal(mutation.parameters.some((parameter) => parameter.name === "Idempotency-Key"), true);
      assert.equal(mutation.parameters.some((parameter) => parameter.name === "Idempotency-Client"), true);
    }
    for (const conditional of [put, patch]) {
      assert.equal(conditional.parameters.some((parameter) => parameter.name === "If-Match" && parameter.required === true), true);
    }

    const paths = z
      .object({
        paths: z.object({
          "/orders": z.object({
            get: z.object({ responses: z.record(z.string(), z.unknown()) }),
            post: z.object({ requestBody: z.unknown(), responses: z.record(z.string(), z.unknown()) }),
          }),
          "/orders/{id}": z.object({
            get: z.object({ responses: z.record(z.string(), z.unknown()) }),
            put: z.object({ requestBody: z.unknown(), responses: z.record(z.string(), z.unknown()) }),
            patch: z.object({ requestBody: z.unknown(), responses: z.record(z.string(), z.unknown()) }),
          }),
          "/orders/{id}/invoice": z.object({
            post: z.object({ responses: z.record(z.string(), z.unknown()) }),
          }),
        }),
      })
      .parse(document).paths;
    assert.match(JSON.stringify(paths["/orders"].get.responses["200"]), /items|total/u);
    assert.match(JSON.stringify(paths["/orders"].post.requestBody), /customerId/u);
    assert.match(JSON.stringify(paths["/orders"].post.requestBody), /productId/u);
    assert.match(JSON.stringify(paths["/orders/{id}"].put.requestBody), /notes|items/u);
    for (const response of [
      paths["/orders/{id}"].get.responses["200"],
      paths["/orders/{id}"].put.responses["200"],
      paths["/orders/{id}"].patch.responses["200"],
    ]) {
      assert.ok(z.object({ headers: z.object({ ETag: z.unknown() }) }).parse(response).headers.ETag);
    }
    for (const responses of [
      paths["/orders/{id}"].put.responses,
      paths["/orders/{id}"].patch.responses,
    ]) {
      assert.equal("412" in responses, true);
      assert.equal("428" in responses, true);
      assert.equal("application/problem+json" in z.object({ content: z.record(z.string(), z.unknown()) }).parse(responses["412"]).content, true);
    }
    assert.equal("200" in paths["/orders/{id}/invoice"].post.responses, true);
    assert.equal("409" in paths["/orders/{id}/invoice"].post.responses, true);
  });
});
