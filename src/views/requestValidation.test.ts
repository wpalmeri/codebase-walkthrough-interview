import {
  ApplyPaymentRequestSchema,
  CreateComboDiscountRequestSchema,
  CreateOrderRequestSchema,
  RecordPaymentRequestSchema,
  ReversePaymentApplicationRequestSchema,
  RevenueReportRequestSchema,
  SendInvoiceRequestSchema,
  OrderConditionalRequestHeadersSchema,
  UpdateRateRequestSchema,
} from "@meridian/contracts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RequestValidationError, validationErrorBody } from "./helpers";

const emptyRequest = { params: {}, query: {}, body: undefined };

void describe("request contracts", () => {
  void test("defines an additive v1 Order If-Match header contract", () => {
    assert.equal(OrderConditionalRequestHeadersSchema.safeParse({ "If-Match": "\"rv1_value\"" }).success, true);
    assert.equal(OrderConditionalRequestHeadersSchema.safeParse({}).success, false);
    assert.equal(OrderConditionalRequestHeadersSchema.safeParse({ "If-Match": "etag", extra: "no" }).success, false);
  });

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

  void test("accepts exact decimal strings without weakening legacy numeric clients", () => {
    assert.equal(
      CreateOrderRequestSchema.safeParse({
        params: {},
        query: {},
        body: {
          customerId: "customer-1",
          items: [{ productId: "product-1", quantity: "0.100001" }],
        },
      }).success,
      true
    );
    assert.equal(
      RecordPaymentRequestSchema.safeParse({
        params: {},
        query: {},
        body: { customerId: "customer-1", amount: "0.1000" },
      }).success,
      true
    );
    assert.equal(
      CreateComboDiscountRequestSchema.safeParse({
        params: {},
        query: {},
        body: { name: "Bundle", productIds: ["product-1"], percentOff: "7.5000" },
      }).success,
      true
    );
  });

  void test("rejects ambiguous or out-of-scale decimal strings at the API boundary", () => {
    for (const amount of ["01.00", "1e2", "0.00001", "-1", "0"]) {
      assert.equal(
        RecordPaymentRequestSchema.safeParse({
          params: {},
          query: {},
          body: { customerId: "customer-1", amount },
        }).success,
        false,
        amount
      );
    }
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

  void test("accepts exact reversal facts and rejects caller-controlled actors", () => {
    const request = {
      params: { id: "payment-1", applicationId: "application-1" },
      query: {},
      body: {
        amount: "25.0000",
        reason: "Duplicate application",
        accountingDate: "2026-09-22",
      },
    };
    assert.equal(ReversePaymentApplicationRequestSchema.safeParse(request).success, true);
    assert.equal(
      ReversePaymentApplicationRequestSchema.safeParse({
        ...request,
        body: { ...request.body, actor: "user:attacker" },
      }).success,
      false
    );
    for (const amount of ["0.0000", "25.00001", -1]) {
      assert.equal(
        ReversePaymentApplicationRequestSchema.safeParse({
          ...request,
          body: { ...request.body, amount },
        }).success,
        false
      );
    }
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
    assert.equal(
      UpdateRateRequestSchema.safeParse({
        params: { id: "rate-1" },
        query: {},
        body: {
          unitPrice: "5",
          tiers: [
            {
              upTo: "100",
              unitPrice: "4",
              floor: "900719925474099.0001",
              ceiling: "900719925474099.0000",
            },
          ],
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
