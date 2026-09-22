import { Prisma } from "@prisma/client";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toInvoiceModel } from "./invoice";
import { toOrderModel } from "./order";
import { toPaymentModel } from "./payment";
import { toProductModel } from "./product";
import { toRateModel } from "./rate";

const createdAt = new Date("2026-09-22T12:00:00.000Z");

const product = {
  id: "product-1",
  resourceVersion: null,
  sku: "LIVE-SKU",
  name: "Live product name",
  unit: "seat",
  listPrice: 999,
  listPriceDecimal: new Prisma.Decimal("12.3400"),
  currencyCode: "USD",
};

void describe("exact financial response models", () => {
  void test("prefers Decimal catalog and rate values while retaining legacy fields", () => {
    const productModel = toProductModel(product);
    const rateModel = toRateModel({
      id: "rate-1",
      resourceVersion: null,
      customerId: "customer-1",
      productId: product.id,
      unitPrice: 888,
      unitPriceDecimal: new Prisma.Decimal("10.1250"),
      currencyCode: "USD",
      tiers: [{ upTo: 10, unitPrice: 10.125, floor: 20 }],
      effectiveDate: createdAt,
      product,
    });

    assert.equal(productModel.listPrice, 999);
    assert.equal(productModel.listPriceDecimal, "12.3400");
    assert.equal(rateModel.unitPrice, 888);
    assert.equal(rateModel.unitPriceDecimal, "10.1250");
    assert.deepEqual(rateModel.tiersDecimal, [
      {
        upTo: "10.000000",
        unitPrice: "10.1250",
        floor: "20.0000",
        ceiling: undefined,
      },
    ]);
  });

  void test("uses captured order snapshots instead of changed live product data", () => {
    const model = toOrderModel({
      id: "order-1",
      resourceVersion: null,
      reference: "SO-1",
      customerId: "customer-1",
      orderDate: createdAt,
      status: "OPEN",
      shipTo: null,
      notes: null,
      currencyCode: "USD",
      customer: {
        name: "Customer",
        email: "billing@example.com",
        billingAddress: null,
      },
      items: [
        {
          id: "item-1",
          orderId: "order-1",
          productId: product.id,
          rateId: "rate-1",
          quantity: 999,
          unitPrice: 999,
          productSkuSnapshot: "ORDER-SKU",
          productNameSnapshot: "Captured product name",
          productUnitSnapshot: "seat",
          quantityDecimal: new Prisma.Decimal("2.000000"),
          baseUnitPriceDecimal: new Prisma.Decimal("12.3400"),
          effectiveUnitPriceDecimal: new Prisma.Decimal("10.1250"),
          amountDecimal: new Prisma.Decimal("20.2499"),
          pricingSnapshot: { version: 1 },
          pricingCapturedAt: createdAt,
          snapshotVersion: 1,
          product,
        },
      ],
      invoice: null,
      comments: [],
    });

    assert.equal(model.items[0]?.productSku, "ORDER-SKU");
    assert.equal(model.items[0]?.productName, "Captured product name");
    assert.equal(model.items[0]?.quantity, 2);
    assert.equal(model.items[0]?.unitPrice, 10.125);
    assert.equal(model.items[0]?.amountDecimal, "20.2499");
    assert.equal(model.totalDecimal, "20.2499");
  });

  void test("derives invoice and payment balances from exact Decimal-first values", () => {
    const payment = {
      id: "payment-1",
      customerId: "customer-1",
      amount: 999,
      amountDecimal: new Prisma.Decimal("25.0000"),
      currencyCode: "USD",
      receivedAt: createdAt,
      reference: null,
    };
    const application = {
      id: "application-1",
      paymentId: payment.id,
      invoiceId: "invoice-1",
      amount: 777,
      amountDecimal: new Prisma.Decimal("5.0000"),
      appliedAt: createdAt,
    };
    const paymentModel = toPaymentModel({
      ...payment,
      customer: { name: "Customer" },
      applications: [{ ...application, invoice: { number: "INV-1" } }],
    });
    const invoiceModel = toInvoiceModel({
      id: "invoice-1",
      resourceVersion: null,
      number: "INV-1",
      customerId: "customer-1",
      orderId: "order-1",
      status: "POSTED",
      issueDate: createdAt,
      dueDate: createdAt,
      accountingDate: "2026-09-22",
      total: 999,
      amountPaid: 777,
      totalDecimal: new Prisma.Decimal("25.0000"),
      amountPaidDecimal: new Prisma.Decimal("5.0000"),
      customerNameSnapshot: "Captured customer",
      customerEmailSnapshot: "captured@example.com",
      billingAddressSnapshot: "1 Snapshot Way",
      currencyCode: "USD",
      postedAt: createdAt,
      customer: {
        name: "Changed customer",
        email: "changed@example.com",
        billingAddress: "2 Live Road",
      },
      order: { reference: "SO-1" },
      lines: [],
      applications: [{ ...application, payment }],
      transmissions: [],
    });

    assert.equal(paymentModel.amountDecimal, "25.0000");
    assert.equal(paymentModel.appliedDecimal, "5.0000");
    assert.equal(paymentModel.unappliedDecimal, "20.0000");
    assert.equal(invoiceModel.customerName, "Captured customer");
    assert.equal(invoiceModel.totalDecimal, "25.0000");
    assert.equal(invoiceModel.amountPaidDecimal, "5.0000");
    assert.equal(invoiceModel.balanceDecimal, "20.0000");
  });
});
