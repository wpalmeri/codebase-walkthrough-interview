import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { captureOrderPricing, exactPricingInput } from "../domain/orderPricing";
import {
  runFinancialReconciliation,
  type FinancialReconciliationRepository,
  type InvoiceReconciliationSource,
  type OrderReconciliationSource,
  type PaymentReconciliationSource,
  type ProductReconciliationSource,
  type RateReconciliationSource,
} from "./financialReconciliation";

type Fixture = {
  products: ProductReconciliationSource[];
  rates: RateReconciliationSource[];
  orders: OrderReconciliationSource[];
  invoices: InvoiceReconciliationSource[];
  payments: PaymentReconciliationSource[];
};

function captured() {
  return captureOrderPricing(
    exactPricingInput({
      product: { id: "product-1", sku: "WIDGET", name: "Widget", unit: "month", currencyCode: "USD" },
      rate: { id: "rate-1", currencyCode: "USD", baseUnitPrice: "2.5", tiers: [] },
      quantity: "4",
      discounts: [{ id: "discount-1", name: "Volume discount", percentOff: "10" }],
      capturedAt: "2026-01-15T12:00:00.000Z",
    })
  );
}

function fixture(): Fixture {
  const pricing = captured();
  const application = {
    id: "application-1",
    amountDecimal: pricing.amountDecimal,
    reversals: [],
    payment: { id: "payment-1", customerId: "customer-1", currencyCode: "USD" },
  };
  return {
    products: [{ id: "product-1", listPriceDecimal: "2.5000", currencyCode: "USD" }],
    rates: [{ id: "rate-1", unitPriceDecimal: "2.5000", currencyCode: "USD", productCurrencyCode: "USD" }],
    orders: [{
      id: "order-1", customerId: "customer-1", currencyCode: "USD", status: "INVOICED",
      items: [{
        id: "item-1", productId: pricing.productId, rateId: pricing.rateId,
        productSkuSnapshot: pricing.productSkuSnapshot, productNameSnapshot: pricing.productNameSnapshot,
        productUnitSnapshot: pricing.productUnitSnapshot, quantityDecimal: pricing.quantityDecimal,
        baseUnitPriceDecimal: pricing.baseUnitPriceDecimal,
        effectiveUnitPriceDecimal: pricing.effectiveUnitPriceDecimal, amountDecimal: pricing.amountDecimal,
        pricingSnapshot: pricing.pricingSnapshot, pricingCapturedAt: new Date(pricing.pricingCapturedAt),
        snapshotVersion: pricing.snapshotVersion,
      }],
    }],
    invoices: [{
      id: "invoice-1", customerId: "customer-1", currencyCode: "USD", status: "PAID",
      postedAt: new Date("2026-01-16T12:00:00.000Z"), accountingDate: "2026-01-16",
      totalDecimal: pricing.amountDecimal, amountPaidDecimal: pricing.amountDecimal,
      customerNameSnapshot: "Customer One", customerEmailSnapshot: "customer@example.com",
      lines: [{ id: "line-1", productSkuSnapshot: pricing.productSkuSnapshot, productUnitSnapshot: pricing.productUnitSnapshot, quantityDecimal: pricing.quantityDecimal, unitPriceDecimal: pricing.effectiveUnitPriceDecimal, amountDecimal: pricing.amountDecimal }],
      applications: [application],
    }],
    payments: [{
      id: "payment-1", customerId: "customer-1", currencyCode: "USD", amountDecimal: pricing.amountDecimal,
      applications: [{ id: application.id, amountDecimal: application.amountDecimal, reversals: [], invoice: { id: "invoice-1", customerId: "customer-1", currencyCode: "USD" } }],
    }],
  };
}

function afterId<T extends { readonly id: string }>(rows: readonly T[], after: string | null, limit: number): readonly T[] {
  return rows.filter((row) => after === null || row.id > after).toSorted((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
}

function repository(data: Fixture): FinancialReconciliationRepository {
  return {
    async fetchProducts(after, limit) { return afterId(data.products, after, limit); },
    async fetchRates(after, limit) { return afterId(data.rates, after, limit); },
    async fetchOrders(after, limit) { return afterId(data.orders, after, limit); },
    async fetchInvoices(after, limit) { return afterId(data.invoices, after, limit); },
    async fetchPayments(after, limit) { return afterId(data.payments, after, limit); },
  };
}

void describe("financial reconciliation", () => {
  void test("reports a fully captured, exact, lifecycle-consistent fixture as clean", async () => {
    const result = await runFinancialReconciliation({}, { repository: repository(fixture()) });

    assert.equal(result.state, "CLEAN");
    assert.equal(result.complete, true);
    assert.deepEqual(result.scanned, { products: 1, rates: 1, orders: 1, invoices: 1, payments: 1 });
    assert.deepEqual(result.issues, []);
  });

  void test("finds missing exact values, currencies and snapshots alongside arithmetic and ledger corruption", async () => {
    const data = fixture();
    data.products[0] = { ...data.products[0], listPriceDecimal: null, currencyCode: null };
    data.rates[0] = { ...data.rates[0], unitPriceDecimal: null, currencyCode: null };
    const order = data.orders[0];
    const item = order.items[0];
    data.orders[0] = { ...order, currencyCode: null, items: [{ ...item, productSkuSnapshot: null, pricingSnapshot: null, amountDecimal: null }] };
    const invoice = data.invoices[0];
    const line = invoice.lines[0];
    data.invoices[0] = {
      ...invoice, status: "PAID", postedAt: null, accountingDate: null, customerNameSnapshot: null,
      totalDecimal: "9.0000", amountPaidDecimal: "8.0000",
      lines: [{ ...line, productSkuSnapshot: null, amountDecimal: "8.0000" }],
      applications: [{ ...invoice.applications[0], amountDecimal: "9.0000", payment: { id: "payment-1", customerId: "other-customer", currencyCode: "EUR" } }],
    };
    const payment = data.payments[0];
    data.payments[0] = {
      ...payment, amountDecimal: "8.0000",
      applications: [{ ...payment.applications[0], amountDecimal: "9.0000", invoice: { id: "invoice-1", customerId: "other-customer", currencyCode: "EUR" } }],
    };

    const result = await runFinancialReconciliation({}, { repository: repository(data) });
    const codes = new Set(result.issues.map((entry) => entry.code));

    assert.equal(result.state, "VIOLATIONS");
    for (const code of [
      "MISSING_EXACT_VALUE", "MISSING_CURRENCY", "MISSING_ORDER_SNAPSHOT", "MISSING_INVOICE_SNAPSHOT",
      "MISSING_ACCOUNTING_DATE", "INVOICE_LINE_TOTAL_MISMATCH", "INVOICE_AMOUNT_PAID_MISMATCH",
      "APPLICATIONS_EXCEED_PAYMENT", "CROSS_CUSTOMER_APPLICATION", "CROSS_CURRENCY_APPLICATION",
      "INVOICE_LIFECYCLE_CONTRADICTION",
    ] as const) assert.ok(codes.has(code), `expected ${code}, received ${[...codes].join(", ")}`);
  });

  void test("returns a continuation cursor instead of claiming a capped entity scan is complete", async () => {
    const data = fixture();
    data.products.push({ id: "product-2", listPriceDecimal: "1.0000", currencyCode: "USD" });

    const result = await runFinancialReconciliation(
      { batchSize: 1, maxBatchesPerEntity: 1 },
      { repository: repository(data) }
    );

    assert.equal(result.complete, false);
    assert.equal(result.cursors.products, "product-1");
    assert.equal(result.scanned.products, 1);
    assert.equal(result.state, "INCOMPLETE");
  });

  void test("reconciles net application amounts and rejects malformed or excessive reversals", async () => {
    const corrected = fixture();
    const reversal = {
      id: "reversal-1",
      amountDecimal: "1.0000",
      accountingDate: "2026-01-17",
      reason: "Correct duplicate application",
      actor: "system:meridian-api",
    };
    const invoice = corrected.invoices[0];
    const payment = corrected.payments[0];
    corrected.invoices[0] = {
      ...invoice,
      status: "POSTED",
      amountPaidDecimal: "8.0000",
      applications: invoice.applications.map((application) => ({
        ...application,
        reversals: [reversal],
      })),
    };
    corrected.payments[0] = {
      ...payment,
      applications: payment.applications.map((application) => ({
        ...application,
        reversals: [reversal],
      })),
    };

    const clean = await runFinancialReconciliation(
      {},
      { repository: repository(corrected) }
    );
    assert.equal(clean.state, "CLEAN");
    assert.deepEqual(clean.issues, []);

    const corrupt = fixture();
    const excessive = { ...reversal, amountDecimal: "10.0000" };
    corrupt.invoices[0] = {
      ...corrupt.invoices[0],
      applications: corrupt.invoices[0].applications.map((application) => ({
        ...application,
        reversals: [excessive],
      })),
    };
    corrupt.payments[0] = {
      ...corrupt.payments[0],
      applications: corrupt.payments[0].applications.map((application) => ({
        ...application,
        reversals: [{ ...excessive, accountingDate: "2026-02-30" }],
      })),
    };
    const violations = await runFinancialReconciliation(
      {},
      { repository: repository(corrupt) }
    );
    const codes = new Set(violations.issues.map((entry) => entry.code));
    assert.ok(codes.has("REVERSALS_EXCEED_APPLICATION"));
    assert.ok(codes.has("INVALID_REVERSAL"));
  });
});
