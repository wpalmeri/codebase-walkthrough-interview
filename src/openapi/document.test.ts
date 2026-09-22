import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { createOpenApiV1Document } from "./document";
import { customerOperations } from "../views/customersView";
import { invoiceOperations } from "../views/invoicesView";
import { orderOperations } from "../views/ordersView";
import { paymentOperations } from "../views/paymentsView";
import { productOperations } from "../views/productsView";
import { rateOperations } from "../views/ratesView";
import { reportOperations } from "../views/reportsView";

const documentedOperations = [
  ...customerOperations,
  ...productOperations,
  ...rateOperations,
  ...orderOperations,
  ...invoiceOperations,
  ...paymentOperations,
  ...reportOperations,
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
  void test("is deterministic and inventories the exact mounted catalog, rate, order, invoice, payment, and report operations", () => {
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
        "get /invoices",
        "get /invoices/{id}",
        "get /orders",
        "get /orders/{id}",
        "get /products",
        "get /payments",
        "get /payments/{id}",
        "get /rates",
        "get /rates/combos",
        "get /rates/{id}",
        "get /reports/annual-revenue",
        "get /reports/revenue-by-customer",
        "get /reports/revenue-by-quarter",
        "patch /orders/{id}",
        "patch /invoices/{id}",
        "post /orders",
        "post /orders/{id}/invoice",
        "post /invoices/{id}/post",
        "post /invoices/{id}/send",
        "post /invoices/transmissions/{transmissionId}/refresh",
        "post /rates/combos",
        "post /payments",
        "post /payments/{id}/apply",
        "post /payments/{id}/applications/{applicationId}/reversals",
        "put /rates/{id}",
        "put /invoices/{id}",
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
    const listSchema = z
      .object({
        content: z.object({
          "application/json": z.object({
            schema: z.object({
              type: z.literal("object"),
              required: z.array(z.string()),
              properties: z.object({
                data: z.object({ type: z.literal("array") }),
                page: z.object({ properties: z.object({ nextCursor: z.unknown() }) }),
              }),
            }),
          }),
        }),
      })
      .parse(paths["/orders"].get.responses["200"]).content["application/json"].schema;
    assert.deepEqual(listSchema.required.toSorted(), ["data", "page"]);
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

  void test("documents only version-one Invoice contracts, exact decimals, delivery boundaries, and conditional writes", () => {
    const document = createOpenApiV1Document(documentedOperations);
    const list = operation(document, "/invoices", "get");
    const get = operation(document, "/invoices/{id}", "get");
    const put = operation(document, "/invoices/{id}", "put");
    const patch = operation(document, "/invoices/{id}", "patch");
    const post = operation(document, "/invoices/{id}/post", "post");
    const send = operation(document, "/invoices/{id}/send", "post");
    const refresh = operation(document, "/invoices/transmissions/{transmissionId}/refresh", "post");
    for (const invoiceOperation of [list, get, put, patch, post, send, refresh]) {
      assert.deepEqual(invoiceOperation.security, [{ tenantBearer: [] }]);
      assert.equal(
        invoiceOperation.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"),
        true
      );
    }
    for (const mutation of [put, patch, post, send, refresh]) {
      assert.equal(mutation.parameters.some((parameter) => parameter.name === "Idempotency-Key"), true);
      assert.equal(mutation.parameters.some((parameter) => parameter.name === "Idempotency-Client"), true);
    }
    for (const conditional of [put, patch]) {
      assert.equal(conditional.parameters.some((parameter) => parameter.name === "If-Match" && parameter.required === true), true);
      assert.equal("412" in conditional.responses, true);
      assert.equal("428" in conditional.responses, true);
    }

    const paths = z
      .object({
        paths: z.object({
          "/invoices": z.object({ get: z.object({ responses: z.record(z.string(), z.unknown()) }) }),
          "/invoices/{id}": z.object({
            get: z.object({ responses: z.record(z.string(), z.unknown()) }),
            put: z.object({ responses: z.record(z.string(), z.unknown()), description: z.string() }),
            patch: z.object({ responses: z.record(z.string(), z.unknown()), description: z.string() }),
          }),
          "/invoices/{id}/send": z.object({ post: z.object({ requestBody: z.unknown() }) }),
          "/invoices/transmissions/{transmissionId}/refresh": z.object({
            post: z.object({ responses: z.record(z.string(), z.unknown()) }),
          }),
        }),
      })
      .parse(document).paths;
    const invoiceJson = JSON.stringify(paths["/invoices"].get.responses["200"]);
    assert.match(invoiceJson, /totalDecimal|amountPaidDecimal|balanceDecimal/u);
    const invoiceProperties = z
      .object({
        content: z.object({
          "application/json": z.object({
            schema: z.object({
              items: z.object({
                properties: z.object({
                  totalDecimal: z.object({ pattern: z.string() }),
                  amountPaidDecimal: z.object({ pattern: z.string() }),
                  balanceDecimal: z.object({ pattern: z.string() }),
                }),
              }),
            }),
          }),
        }),
      })
      .parse(paths["/invoices"].get.responses["200"]).content["application/json"].schema.items.properties;
    for (const decimal of [
      invoiceProperties.totalDecimal,
      invoiceProperties.amountPaidDecimal,
      invoiceProperties.balanceDecimal,
    ]) {
      assert.equal(decimal.pattern, "^(?:0|[1-9]\\d{0,14})\\.\\d{4}$");
    }
    assert.match(JSON.stringify(paths["/invoices/{id}/send"].post.requestBody), /EMAIL|PORTAL|API/u);
    assert.match(JSON.stringify(paths["/invoices/transmissions/{transmissionId}/refresh"].post.responses["200"]), /externalJobId/u);
    for (const response of [
      paths["/invoices/{id}"].get.responses["200"],
      paths["/invoices/{id}"].put.responses["200"],
      paths["/invoices/{id}"].patch.responses["200"],
    ]) {
      assert.ok(z.object({ headers: z.object({ ETag: z.unknown() }) }).parse(response).headers.ETag);
    }
    assert.doesNotMatch(paths["/invoices/{id}"].put.description, /legacy|\/api(?!\/v1)/u);
    assert.doesNotMatch(paths["/invoices/{id}"].patch.description, /legacy|\/api(?!\/v1)/u);
  });

  void test("documents tenant-scoped exact-decimal revenue reports and bounded period filters", () => {
    const document = createOpenApiV1Document(documentedOperations);
    const quarter = operation(document, "/reports/revenue-by-quarter", "get");
    const customer = operation(document, "/reports/revenue-by-customer", "get");
    const annual = operation(document, "/reports/annual-revenue", "get");
    for (const reportOperation of [quarter, customer, annual]) {
      assert.deepEqual(reportOperation.security, [{ tenantBearer: [] }]);
      assert.equal(
        reportOperation.parameters.some((parameter) => parameter.name === "X-Request-ID" && parameter.in === "header"),
        true
      );
      assert.equal(reportOperation.parameters.some((parameter) => parameter.name === "from" && parameter.in === "query"), true);
      assert.equal(reportOperation.parameters.some((parameter) => parameter.name === "to" && parameter.in === "query"), true);
      assert.equal("400" in reportOperation.responses, true);
      assert.equal("401" in reportOperation.responses, true);
      assert.equal("403" in reportOperation.responses, true);
      assert.equal("500" in reportOperation.responses, true);
    }
    const paths = z
      .object({
        paths: z.object({
          "/reports/revenue-by-quarter": z.object({ get: z.object({ responses: z.record(z.string(), z.unknown()) }) }),
          "/reports/revenue-by-customer": z.object({ get: z.object({ responses: z.record(z.string(), z.unknown()) }) }),
          "/reports/annual-revenue": z.object({ get: z.object({ responses: z.record(z.string(), z.unknown()) }) }),
        }),
      })
      .parse(document).paths;
    assert.match(JSON.stringify(paths["/reports/revenue-by-quarter"].get.responses["200"]), /quarter|revenueDecimal/u);
    assert.match(JSON.stringify(paths["/reports/revenue-by-customer"].get.responses["200"]), /customerId|revenueDecimal/u);
    assert.match(JSON.stringify(paths["/reports/annual-revenue"].get.responses["200"]), /year|revenueDecimal/u);
    for (const response of [
      paths["/reports/revenue-by-quarter"].get.responses["200"],
      paths["/reports/revenue-by-customer"].get.responses["200"],
      paths["/reports/annual-revenue"].get.responses["200"],
    ]) {
      assert.ok(z.object({ headers: z.object({ "X-Request-ID": z.unknown() }) }).parse(response).headers["X-Request-ID"]);
    }
  });
});
