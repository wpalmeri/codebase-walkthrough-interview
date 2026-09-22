import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { captureOrderPricing, exactPricingInput, repriceOrderPricingSnapshot } from "./orderPricing";

const capturedAt = "2026-09-22T12:00:00.000Z";

function baseInput() {
  return {
    product: {
      id: "product-1",
      sku: "SEAT",
      name: "Platform seat",
      unit: "seat",
      currencyCode: "USD",
    },
    rate: {
      id: "rate-1",
      currencyCode: "USD",
      baseUnitPrice: "0.1000",
      tiers: [] as {
        upTo: string | null;
        unitPrice: string;
        floor?: string | null;
        ceiling?: string | null;
      }[],
    },
    quantity: "3.000000",
    discounts: [] as { id: string; name: string; percentOff: string }[],
    capturedAt,
  };
}

void describe("order pricing snapshots", () => {
  void test("captures exact JSON-safe values without binary-float drift", () => {
    const captured = captureOrderPricing(exactPricingInput(baseInput()));

    assert.equal(captured.quantityDecimal, "3.000000");
    assert.equal(captured.baseUnitPriceDecimal, "0.1000");
    assert.equal(captured.amountDecimal, "0.3000");
    assert.equal(captured.effectiveUnitPriceDecimal, "0.1000");
    assert.equal(JSON.parse(JSON.stringify(captured)).pricingSnapshot.total, "0.3000");
  });

  void test("applies tiers, floors, and discounts in deterministic id order", () => {
    const input = baseInput();
    input.quantity = "3.000000";
    input.rate.tiers = [{ upTo: null, unitPrice: "1.0000", floor: "5.0000" }];
    input.discounts = [
      { id: "discount-z", name: "Second", percentOff: "20.0000" },
      { id: "discount-a", name: "First", percentOff: "10.0000" },
    ];

    const captured = captureOrderPricing(exactPricingInput(input));

    assert.equal(captured.pricingSnapshot.subtotal, "5.0000");
    assert.deepEqual(
      captured.pricingSnapshot.discounts.map((discount) => [discount.id, discount.amountAfter]),
      [
        ["discount-a", "4.5000"],
        ["discount-z", "3.6000"],
      ]
    );
    assert.equal(captured.amountDecimal, "3.6000");
    assert.equal(captured.effectiveUnitPriceDecimal, "1.2000");
  });

  void test("does not change after mutable catalog inputs change", () => {
    const input = baseInput();
    input.rate.tiers = [{ upTo: null, unitPrice: "2.0000" }];
    input.discounts = [{ id: "discount-1", name: "Original", percentOff: "10.0000" }];
    const captured = captureOrderPricing(exactPricingInput(input));

    input.product.name = "Renamed live product";
    input.rate.baseUnitPrice = "999.0000";
    input.rate.tiers[0].unitPrice = "999.0000";
    input.discounts[0].name = "Changed live discount";
    input.discounts[0].percentOff = "99.0000";

    assert.equal(captured.productNameSnapshot, "Platform seat");
    assert.equal(captured.pricingSnapshot.rate.tiers[0]?.unitPrice, "2.0000");
    assert.equal(captured.pricingSnapshot.discounts[0]?.name, "Original");
    assert.equal(captured.amountDecimal, "5.4000");
  });

  void test("reprices a quantity change from captured terms rather than changed live terms", () => {
    const input = baseInput();
    input.rate.baseUnitPrice = "4.0000";
    input.discounts = [{ id: "discount-1", name: "Captured ten percent", percentOff: "10.0000" }];
    const original = captureOrderPricing(exactPricingInput(input));

    input.rate.baseUnitPrice = "999.0000";
    input.discounts[0].percentOff = "99.0000";
    const repriced = repriceOrderPricingSnapshot(original.pricingSnapshot, "5.000000");

    assert.equal(repriced.baseUnitPriceDecimal, "4.0000");
    assert.equal(repriced.quantityDecimal, "5.000000");
    assert.equal(repriced.amountDecimal, "18.0000");
    assert.equal(repriced.pricingCapturedAt, original.pricingCapturedAt);
  });

  void test("rejects mismatched currencies, uncovered tiers, duplicate discounts, and zero quantity", () => {
    const currencyMismatch = baseInput();
    currencyMismatch.rate.currencyCode = "EUR";
    assert.throws(
      () => captureOrderPricing(exactPricingInput(currencyMismatch)),
      /product and rate currencies must match/
    );

    const uncovered = baseInput();
    uncovered.quantity = "2.000000";
    uncovered.rate.tiers = [{ upTo: "1.000000", unitPrice: "1.0000" }];
    assert.throws(
      () => captureOrderPricing(exactPricingInput(uncovered)),
      /rate tiers do not cover the full quantity/
    );

    const duplicateDiscount = baseInput();
    duplicateDiscount.discounts = [
      { id: "same", name: "One", percentOff: "1.0000" },
      { id: "same", name: "Two", percentOff: "2.0000" },
    ];
    assert.throws(
      () => captureOrderPricing(exactPricingInput(duplicateDiscount)),
      /discount ids must be unique/
    );

    const zeroQuantity = baseInput();
    zeroQuantity.quantity = "0.000000";
    assert.throws(
      () => captureOrderPricing(exactPricingInput(zeroQuantity)),
      /quantity must be greater than zero/
    );
  });
});
