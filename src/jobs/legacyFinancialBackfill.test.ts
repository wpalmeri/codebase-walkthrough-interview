import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  prepareDiscountFinancialBackfill,
  preparePaymentApplicationFinancialBackfill,
  preparePaymentFinancialBackfill,
  prepareProductFinancialBackfill,
  prepareRateFinancialBackfill,
} from "./legacyFinancialBackfill";

const invoice = {
  id: "invoice-1",
  customerId: "customer-1",
  currencyCode: null,
  total: 10,
  totalDecimal: null,
  amountPaid: 5,
  amountPaidDecimal: null,
  applications: [{ id: "application-1", amount: 5, amountDecimal: null }],
};

void describe("safe legacy financial backfill preparation", () => {
  void test("derives exact product fields without changing an existing agreeing exact value", () => {
    const result = prepareProductFinancialBackfill({
      id: "product-1",
      beforeAmount: "1.2500",
      listPrice: 1.25,
      listPriceDecimal: "1.2500",
      currencyCode: null,
    });
    assert.deepEqual(result, {
      kind: "ready",
      afterAmount: "1.2500",
      write: { id: "product-1", listPriceDecimal: "1.2500", currencyCode: "USD" },
    });
  });

  void test("rejects unrepresentable floats and disagreements with preserved exact facts", () => {
    const unrepresentable = prepareDiscountFinancialBackfill({
      id: "discount-1",
      beforeAmount: "0.0000",
      percentOff: 0.30000000000000004,
      percentOffDecimal: null,
    });
    assert.equal(unrepresentable.kind, "unsafe");
    if (unrepresentable.kind === "unsafe") {
      assert.equal(unrepresentable.code, "UNREPRESENTABLE_LEGACY_DECIMAL");
    }

    const mismatch = prepareProductFinancialBackfill({
      id: "product-1",
      beforeAmount: "1.2500",
      listPrice: 1.25,
      listPriceDecimal: "1.5000",
      currencyCode: "USD",
    });
    assert.equal(mismatch.kind, "unsafe");
    if (mismatch.kind === "unsafe") assert.equal(mismatch.code, "EXACT_VALUE_MISMATCH");
  });

  void test("converts only valid legacy tiers to decimal-string JSON", () => {
    const result = prepareRateFinancialBackfill({
      id: "rate-1",
      beforeAmount: "2.5000",
      unitPrice: 2.5,
      unitPriceDecimal: null,
      currencyCode: null,
      productCurrencyCode: null,
      tiers: [{ upTo: 10, unitPrice: 2.5, floor: 5 }],
    });
    assert.deepEqual(result, {
      kind: "ready",
      afterAmount: "2.5000",
      write: {
        id: "rate-1",
        unitPriceDecimal: "2.5000",
        currencyCode: "USD",
        tiers: [{ upTo: "10.000000", unitPrice: "2.5000", floor: "5.0000" }],
      },
    });

    const malformed = prepareRateFinancialBackfill({
      id: "rate-2",
      beforeAmount: "2.5000",
      unitPrice: 2.5,
      unitPriceDecimal: null,
      currencyCode: null,
      productCurrencyCode: null,
      tiers: [{ upTo: "not-a-number", unitPrice: 2.5 }],
    });
    assert.equal(malformed.kind, "unsafe");
    if (malformed.kind === "unsafe") assert.equal(malformed.code, "MALFORMED_RATE_TIERS");

    const alreadyExact = prepareRateFinancialBackfill({
      id: "rate-exact",
      beforeAmount: "2.5000",
      unitPrice: 2.5,
      unitPriceDecimal: "2.5000",
      currencyCode: "USD",
      productCurrencyCode: "USD",
      tiers: [
        {
          upTo: null,
          unitPrice: "900719925474099.0001",
          floor: "0.0001",
        },
      ],
    });
    assert.equal(alreadyExact.kind, "ready");
    if (alreadyExact.kind === "ready") {
      assert.deepEqual(alreadyExact.write.tiers, [
        {
          upTo: null,
          unitPrice: "900719925474099.0001",
          floor: "0.0001",
        },
      ]);
    }
  });

  void test("rejects payment applications that exceed payment or cross customer facts", () => {
    const exceedsPayment = preparePaymentFinancialBackfill({
      id: "payment-1",
      beforeAmount: "4.0000",
      customerId: "customer-1",
      amount: 4,
      amountDecimal: null,
      currencyCode: null,
      applications: [{ id: "application-1", amount: 5, amountDecimal: null, invoice }],
    });
    assert.equal(exceedsPayment.kind, "unsafe");
    if (exceedsPayment.kind === "unsafe") assert.equal(exceedsPayment.code, "APPLICATION_EXCEEDS_PAYMENT");

    const application = preparePaymentApplicationFinancialBackfill({
      id: "application-1",
      beforeAmount: "5.0000",
      amount: 5,
      amountDecimal: null,
      payment: {
        id: "payment-1",
        customerId: "other-customer",
        currencyCode: null,
        amount: 5,
        amountDecimal: null,
        applications: [{ id: "application-1", amount: 5, amountDecimal: null, invoice }],
      },
      invoice,
    });
    assert.equal(application.kind, "unsafe");
    if (application.kind === "unsafe") assert.equal(application.code, "CROSS_CUSTOMER_APPLICATION");

    const crossCurrency = preparePaymentApplicationFinancialBackfill({
      id: "application-1",
      beforeAmount: "5.0000",
      amount: 5,
      amountDecimal: null,
      payment: {
        id: "payment-1",
        customerId: "customer-1",
        currencyCode: "USD",
        amount: 5,
        amountDecimal: null,
        applications: [
          { id: "application-1", amount: 5, amountDecimal: null, invoice: { ...invoice, currencyCode: "EUR" } },
        ],
      },
      invoice: { ...invoice, currencyCode: "EUR" },
    });
    assert.equal(crossCurrency.kind, "unsafe");
    if (crossCurrency.kind === "unsafe") {
      assert.equal(crossCurrency.code, "CROSS_CURRENCY_APPLICATION");
    }
  });

  void test("rejects applications that exceed invoice facts or have unreconciled invoice allocations", () => {
    const exceedsInvoice = preparePaymentApplicationFinancialBackfill({
      id: "application-1",
      beforeAmount: "11.0000",
      amount: 11,
      amountDecimal: null,
      payment: {
        id: "payment-1",
        customerId: "customer-1",
        currencyCode: null,
        amount: 11,
        amountDecimal: null,
        applications: [{ id: "application-1", amount: 11, amountDecimal: null, invoice }],
      },
      invoice: { ...invoice, applications: [{ id: "application-1", amount: 11, amountDecimal: null }] },
    });
    assert.equal(exceedsInvoice.kind, "unsafe");
    if (exceedsInvoice.kind === "unsafe") assert.equal(exceedsInvoice.code, "APPLICATION_EXCEEDS_INVOICE");

    const unreconciled = preparePaymentApplicationFinancialBackfill({
      id: "application-1",
      beforeAmount: "5.0000",
      amount: 5,
      amountDecimal: null,
      payment: {
        id: "payment-1",
        customerId: "customer-1",
        currencyCode: null,
        amount: 5,
        amountDecimal: null,
        applications: [{ id: "application-1", amount: 5, amountDecimal: null, invoice }],
      },
      invoice: { ...invoice, amountPaid: 4 },
    });
    assert.equal(unreconciled.kind, "unsafe");
    if (unreconciled.kind === "unsafe") {
      assert.equal(unreconciled.code, "UNRECONCILED_INVOICE_APPLICATIONS");
    }
  });
});
