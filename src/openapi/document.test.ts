import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { createOpenApiV1Document } from "./document";
import { customerOperations } from "../views/customersView";
import { productOperations } from "../views/productsView";
import { rateOperations } from "../views/ratesView";

const catalogAndRateOperations = [...customerOperations, ...productOperations, ...rateOperations] as const;

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
  void test("is deterministic and inventories the exact mounted catalog and rate operations", () => {
    const first = createOpenApiV1Document(catalogAndRateOperations);
    const second = createOpenApiV1Document(catalogAndRateOperations);
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
        "get /products",
        "get /rates",
        "get /rates/combos",
        "get /rates/{id}",
        "post /rates/combos",
        "put /rates/{id}",
      ].toSorted()
    );
    assert.doesNotThrow(() => createOpenApiV1Document(catalogAndRateOperations));
    assert.throws(
      () => createOpenApiV1Document([...catalogAndRateOperations, customerOperations[0]]),
      /Duplicate OpenAPI operation/u
    );
  });

  void test("documents tenant bearer security, correlation, replay, and rate conditional headers", () => {
    const document = createOpenApiV1Document(catalogAndRateOperations);
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
});
