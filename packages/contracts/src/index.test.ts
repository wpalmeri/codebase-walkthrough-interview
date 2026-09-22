import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ComboDiscountSchema,
  CurrencyCodeSchema,
  DecimalStringSchema,
  InvoiceLineSchema,
  InvoicePaymentSchema,
  InvoiceSchema,
  MoneyStringSchema,
  OrderItemSchema,
  OrderSchema,
  PaymentApplicationSchema,
  PaymentSchema,
  PercentageStringSchema,
  ProblemDetailsSchema,
  ProductSchema,
  QuantityStringSchema,
  RateSchema,
} from "./index.js";

const date = "2026-09-22T12:00:00.000Z";

const product = { id: "product-1", sku: "SKU-1", name: "Service", unit: "seat", listPrice: 12.34 };
const rate = {
  id: "rate-1",
  customerId: "customer-1",
  productId: "product-1",
  unitPrice: 12.34,
  tiers: [],
  effectiveDate: date,
};
const discount = {
  id: "discount-1",
  customerId: null,
  name: "Launch discount",
  products: [{ id: "product-1", sku: "SKU-1", name: "Service" }],
  percentOff: 7.5,
};
const orderItem = {
  id: "item-1",
  productId: "product-1",
  rateId: "rate-1",
  quantity: 2,
  unitPrice: 12.34,
  amount: 24.68,
};
const order = {
  id: "order-1",
  reference: null,
  customerId: "customer-1",
  orderDate: date,
  status: "OPEN",
  shipTo: null,
  notes: null,
  items: [orderItem],
  comments: [],
  total: 24.68,
  invoiceId: null,
  invoiceNumber: null,
  invoiceStatus: null,
};
const invoiceLine = {
  id: "line-1",
  description: "Service",
  quantity: 2,
  unitPrice: 12.34,
  amount: 24.68,
};
const invoicePayment = {
  id: "application-1",
  paymentId: "payment-1",
  amount: 24.68,
  receivedAt: date,
  reference: null,
};
const invoice = {
  id: "invoice-1",
  number: "INV-1",
  customerId: "customer-1",
  orderId: "order-1",
  status: "DRAFT",
  issueDate: date,
  dueDate: date,
  total: 24.68,
  amountPaid: 0,
  balance: 24.68,
  postedAt: null,
  lines: [invoiceLine],
  payments: [invoicePayment],
  transmissions: [],
  lastTransmission: null,
};
const application = {
  id: "application-1",
  invoiceId: "invoice-1",
  amount: 24.68,
  appliedAt: date,
};
const payment = {
  id: "payment-1",
  customerId: "customer-1",
  amount: 24.68,
  receivedAt: date,
  reference: null,
  applied: 24.68,
  unapplied: 0,
  applications: [application],
};

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

void describe("financial response contracts", () => {
  void test("keeps legacy JSON responses valid while decimal fields are rolling out", () => {
    assert.doesNotThrow(() => ProductSchema.parse(json(product)));
    assert.doesNotThrow(() => RateSchema.parse(json(rate)));
    assert.doesNotThrow(() => ComboDiscountSchema.parse(json(discount)));
    assert.doesNotThrow(() => OrderItemSchema.parse(json(orderItem)));
    assert.doesNotThrow(() => OrderSchema.parse(json(order)));
    assert.doesNotThrow(() => InvoiceLineSchema.parse(json(invoiceLine)));
    assert.doesNotThrow(() => InvoicePaymentSchema.parse(json(invoicePayment)));
    assert.doesNotThrow(() => InvoiceSchema.parse(json(invoice)));
    assert.doesNotThrow(() => PaymentApplicationSchema.parse(json(application)));
    assert.doesNotThrow(() => PaymentSchema.parse(json(payment)));
  });

  void test("accepts canonical exact fields alongside legacy numeric response fields", () => {
    const parsedProduct = ProductSchema.parse(
      json({ ...product, listPriceDecimal: "12.3400", currencyCode: "USD" })
    );
    const parsedRate = RateSchema.parse(
      json({
        ...rate,
        unitPriceDecimal: "12.3400",
        currencyCode: "USD",
        tiersDecimal: [{ upTo: null, unitPrice: "12.3400" }],
      })
    );
    const parsedDiscount = ComboDiscountSchema.parse(
      json({ ...discount, percentOffDecimal: "7.5000" })
    );
    const parsedOrder = OrderSchema.parse(
      json({
        ...order,
        currencyCode: "USD",
        totalDecimal: "22.8290",
        items: [
          {
            ...orderItem,
            quantityDecimal: "2.000000",
            baseUnitPriceDecimal: "12.3400",
            effectiveUnitPriceDecimal: "11.4145",
            amountDecimal: "22.8290",
          },
        ],
      })
    );
    const parsedInvoice = InvoiceSchema.parse(
      json({
        ...invoice,
        totalDecimal: "24.6800",
        amountPaidDecimal: "0.0000",
        currencyCode: "USD",
        balanceDecimal: "24.6800",
        lines: [
          {
            ...invoiceLine,
            quantityDecimal: "2.000000",
            unitPriceDecimal: "12.3400",
            amountDecimal: "24.6800",
          },
        ],
        payments: [{ ...invoicePayment, amountDecimal: "24.6800" }],
      })
    );
    const parsedPayment = PaymentSchema.parse(
      json({
        ...payment,
        amountDecimal: "24.6800",
        currencyCode: "USD",
        appliedDecimal: "24.6800",
        unappliedDecimal: "0.0000",
        applications: [{ ...application, amountDecimal: "24.6800" }],
      })
    );

    assert.equal(parsedProduct.listPriceDecimal, "12.3400");
    assert.equal(parsedRate.currencyCode, "USD");
    assert.equal(parsedRate.tiersDecimal?.[0]?.unitPrice, "12.3400");
    assert.equal(parsedDiscount.percentOffDecimal, "7.5000");
    assert.equal(parsedOrder.items[0]?.effectiveUnitPriceDecimal, "11.4145");
    assert.equal(parsedOrder.totalDecimal, "22.8290");
    assert.equal(parsedInvoice.lines[0]?.amountDecimal, "24.6800");
    assert.equal(parsedInvoice.payments[0]?.amountDecimal, "24.6800");
    assert.equal(parsedInvoice.balanceDecimal, "24.6800");
    assert.equal(parsedPayment.applications[0]?.amountDecimal, "24.6800");
    assert.equal(parsedPayment.unappliedDecimal, "0.0000");
  });

  void test("rejects noncanonical values before they become an exact JSON contract", () => {
    assert.equal(DecimalStringSchema.parse("120.50"), "120.50");
    assert.equal(MoneyStringSchema.parse("999999999999999.9999"), "999999999999999.9999");
    assert.equal(QuantityStringSchema.parse("9999999999999.999999"), "9999999999999.999999");
    assert.equal(PercentageStringSchema.parse("100.0000"), "100.0000");
    assert.equal(CurrencyCodeSchema.parse("USD"), "USD");

    assert.throws(() => DecimalStringSchema.parse("01.0"));
    assert.throws(() => MoneyStringSchema.parse("12.34"));
    assert.throws(() => MoneyStringSchema.parse("1000000000000000.0000"));
    assert.throws(() => QuantityStringSchema.parse("10000000000000.000000"));
    assert.throws(() => PercentageStringSchema.parse("100.0001"));
    assert.throws(() => PercentageStringSchema.parse("7.5"));
    assert.throws(() => PercentageStringSchema.parse("not-a-decimal"));
    assert.throws(() => CurrencyCodeSchema.parse("usd"));
    assert.throws(() => CurrencyCodeSchema.parse("US"));
    assert.throws(() => CurrencyCodeSchema.parse("EUR"));
  });
});

void describe("problem-details contract", () => {
  void test("accepts only stable client-safe error envelopes", () => {
    const valid = {
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "VERSION_CONFLICT",
    };

    assert.equal(ProblemDetailsSchema.safeParse(valid).success, true);
    assert.equal(ProblemDetailsSchema.safeParse({ ...valid, status: 200 }).success, false);
    assert.equal(
      ProblemDetailsSchema.safeParse({ ...valid, code: "version-conflict" }).success,
      false
    );
    assert.equal(ProblemDetailsSchema.safeParse({ ...valid, debug: "secret" }).success, false);
  });
});
