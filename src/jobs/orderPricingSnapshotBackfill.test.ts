import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { captureOrderPricing, exactPricingInput } from "../domain/orderPricing";
import {
  prepareOrderPricingSnapshotBackfill,
  type OrderPricingSnapshotBackfillSource,
} from "./orderPricingSnapshotBackfill";

function captured(currencyCode = "USD") {
  return captureOrderPricing(
    exactPricingInput({
      product: { id: "product-original", sku: "ORIGINAL-SKU", name: "Original Product", unit: "month", currencyCode },
      rate: { id: "rate-original", currencyCode, baseUnitPrice: "2.5", tiers: [] },
      quantity: "4",
      discounts: [{ id: "discount-original", name: "Original discount", percentOff: "10" }],
      capturedAt: "2026-01-15T12:00:00.000Z",
    })
  );
}

function source(snapshot = captured()): OrderPricingSnapshotBackfillSource {
  return {
    id: "order-1",
    beforeAmount: "0.0000",
    currencyCode: null,
    items: [
      {
        id: "item-1",
        productSkuSnapshot: null,
        productNameSnapshot: null,
        productUnitSnapshot: null,
        quantityDecimal: null,
        baseUnitPriceDecimal: null,
        effectiveUnitPriceDecimal: null,
        amountDecimal: null,
        pricingSnapshot: snapshot.pricingSnapshot,
        pricingCapturedAt: null,
        snapshotVersion: null,
      },
    ],
  };
}

void describe("order pricing snapshot backfill preparation", () => {
  void test("rehydrates only exact fields proven by its persisted snapshot", () => {
    const result = prepareOrderPricingSnapshotBackfill(source());
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;
    assert.equal(result.write.currencyCode, "USD");
    assert.deepEqual(result.write.items[0], {
      id: "item-1",
      productSkuSnapshot: "ORIGINAL-SKU",
      productNameSnapshot: "Original Product",
      productUnitSnapshot: "month",
      quantityDecimal: "4.000000",
      baseUnitPriceDecimal: "2.5000",
      effectiveUnitPriceDecimal: "2.2500",
      amountDecimal: "9.0000",
      pricingCapturedAt: new Date("2026-01-15T12:00:00.000Z"),
      snapshotVersion: 1,
    });
  });

  void test("refuses missing or conflicting historical evidence", () => {
    const base = source();
    const missing = { ...base, items: base.items.map((item) => ({ ...item, pricingSnapshot: null })) };
    const missingResult = prepareOrderPricingSnapshotBackfill(missing);
    assert.equal(missingResult.kind, "unsafe");
    if (missingResult.kind === "unsafe") assert.equal(missingResult.code, "MISSING_PRICING_EVIDENCE");

    const conflict = { ...base, items: base.items.map((item) => ({ ...item, amountDecimal: "10.0000" })) };
    const conflictResult = prepareOrderPricingSnapshotBackfill(conflict);
    assert.equal(conflictResult.kind, "unsafe");
    if (conflictResult.kind === "unsafe") {
      assert.equal(conflictResult.code, "CONFLICTING_PERSISTED_EVIDENCE");
    }
  });

  void test("refuses an order currency that disagrees with its captured item evidence", () => {
    const base = source();
    const disagreement = {
      ...base,
      currencyCode: "EUR",
    };
    const result = prepareOrderPricingSnapshotBackfill(disagreement);
    assert.equal(result.kind, "unsafe");
    if (result.kind === "unsafe") assert.equal(result.code, "CONFLICTING_PERSISTED_EVIDENCE");
  });
});
