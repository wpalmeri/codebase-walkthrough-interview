import {
  ApplyPaymentRequestSchema,
  CreateOrderRequestSchema,
  RevenueReportRequestSchema,
  SendInvoiceRequestSchema,
  UpdateRateRequestSchema,
} from "@meridian/contracts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RequestValidationError, validationErrorBody } from "./helpers";

const emptyRequest = { params: {}, query: {}, body: undefined };

void describe("request contracts", () => {
  void test("accepts a valid order and rejects unknown fields", () => {
    const valid = {
      params: {},
      query: {},
      body: {
        customerId: "customer-1",
        items: [{ productId: "product-1", quantity: 2.5 }],
      },
    };
    assert.equal(CreateOrderRequestSchema.safeParse(valid).success, true);
    assert.equal(
      CreateOrderRequestSchema.safeParse({
        ...valid,
        body: { ...valid.body, status: "CLOSED" },
      }).success,
      false
    );
  });

  void test("rejects non-positive quantities and duplicate products", () => {
    const request = {
      params: {},
      query: {},
      body: {
        customerId: "customer-1",
        items: [
          { productId: "product-1", quantity: 0 },
          { productId: "product-1", quantity: 1 },
        ],
      },
    };
    const result = CreateOrderRequestSchema.safeParse(request);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(
        result.error.issues
          .map((issue) => issue.message)
          .includes("Product IDs must be unique")
      );
    }
  });

  void test("constrains transmission methods to the shared enum", () => {
    assert.equal(
      SendInvoiceRequestSchema.safeParse({
        params: { id: "invoice-1" },
        query: {},
        body: { method: "FAX" },
      }).success,
      false
    );
  });

  void test("requires positive, uniquely targeted payment applications", () => {
    assert.equal(
      ApplyPaymentRequestSchema.safeParse({
        params: { id: "payment-1" },
        query: {},
        body: {
          applications: [
            { invoiceId: "invoice-1", amount: 10 },
            { invoiceId: "invoice-1", amount: -1 },
          ],
        },
      }).success,
      false
    );
  });

  void test("accepts ISO dates and rejects inverted report periods", () => {
    assert.equal(
      RevenueReportRequestSchema.safeParse({
        ...emptyRequest,
        query: { from: "2026-01-01", to: "2026-12-31" },
      }).success,
      true
    );
    assert.equal(
      RevenueReportRequestSchema.safeParse({
        ...emptyRequest,
        query: { from: "2026-12-31", to: "2026-01-01" },
      }).success,
      false
    );
    assert.equal(
      RevenueReportRequestSchema.safeParse({
        ...emptyRequest,
        query: { from: "01/01/2026" },
      }).success,
      false
    );
  });

  void test("rejects inconsistent tier schedules", () => {
    assert.equal(
      UpdateRateRequestSchema.safeParse({
        params: { id: "rate-1" },
        query: {},
        body: {
          unitPrice: 5,
          tiers: [
            { upTo: null, unitPrice: 5 },
            { upTo: 100, unitPrice: 4 },
          ],
        },
      }).success,
      false
    );
    assert.equal(
      UpdateRateRequestSchema.safeParse({
        params: { id: "rate-1" },
        query: {},
        body: {
          unitPrice: 5,
          tiers: [{ upTo: 100, unitPrice: 4, floor: 50, ceiling: 40 }],
        },
      }).success,
      false
    );
  });
});

void test("validation failures have a stable structured response body", () => {
  const payload = validationErrorBody(
    new RequestValidationError([
      {
        code: "too_small",
        path: "body.items.0.quantity",
        message: "Too small",
      },
    ])
  );

  assert.deepEqual(payload, {
    error: "Request validation failed",
    code: "VALIDATION_ERROR",
    issues: [
      {
        code: "too_small",
        path: "body.items.0.quantity",
        message: "Too small",
      },
    ],
  });
});
