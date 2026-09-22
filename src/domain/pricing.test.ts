import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateLinePricing,
  calculatePricingTotals,
  hourlySubtotal,
  productSubtotal,
  subscriptionSubtotal,
  tieredSubtotal,
} from "./pricing";

void describe("decimal-safe subtotals", () => {
  void test("does not accumulate binary floating-point errors", () => {
    assert.equal(productSubtotal("0.10", "3"), "0.30");
    assert.equal(hourlySubtotal("19.99", "1.5"), "29.99");
    assert.equal(subscriptionSubtotal("12.50", 0), "0.00");
    assert.equal(subscriptionSubtotal("12.50", 3), "37.50");
  });

  void test("rounds monetary boundaries half away from zero", () => {
    assert.equal(productSubtotal("1.005", 1), "1.01");
    assert.equal(productSubtotal("2.675", 1), "2.68");
    assert.equal(productSubtotal("1.0049", 1), "1.00");
  });

  void test("accepts zero and rejects invalid quantities and hours", () => {
    assert.equal(productSubtotal("99.00", 0), "0.00");
    assert.throws(() => productSubtotal("1.00", -1), /quantity must be zero or greater/);
    assert.throws(
      () => hourlySubtotal("125.00", "-0.25"),
      /hours must be zero or greater/
    );
    assert.throws(() => hourlySubtotal("125.00", Number.NaN), /finite decimal/);
    assert.throws(() => subscriptionSubtotal("12.50", -1), /periods must be zero or greater/);
  });
});

void describe("tiered pricing", () => {
  const tiers = [
    { upTo: 10, unitPrice: "10.00" },
    { upTo: 20, unitPrice: "8.00" },
    { upTo: null, unitPrice: "5.00" },
  ] as const;

  void test("charges the correct interval on exact tier boundaries", () => {
    assert.equal(tieredSubtotal("99.00", 10, tiers), "100.00");
    assert.equal(tieredSubtotal("99.00", 20, tiers), "180.00");
    assert.equal(tieredSubtotal("99.00", 21, tiers), "185.00");
  });

  void test("applies per-tier floors and ceilings", () => {
    assert.equal(
      tieredSubtotal("99.00", 3, [{ upTo: null, unitPrice: "2.00", floor: "10.00" }]),
      "10.00"
    );
    assert.equal(
      tieredSubtotal("99.00", 3, [{ upTo: null, unitPrice: "5.00", ceiling: "12.00" }]),
      "12.00"
    );
  });

  void test("rejects malformed or incomplete tiers", () => {
    assert.throws(
      () => tieredSubtotal("1.00", 11, [{ upTo: 10, unitPrice: "1.00" }]),
      /do not cover/
    );
    assert.throws(
      () =>
        tieredSubtotal("1.00", 5, [
          { upTo: 10, unitPrice: "1.00" },
          { upTo: 10, unitPrice: "0.50" },
        ]),
      /greater than the previous bound/
    );
    assert.throws(
      () =>
        tieredSubtotal("1.00", 5, [
          { upTo: null, unitPrice: "1.00" },
          { upTo: null, unitPrice: "0.50" },
        ]),
      /only the final tier/
    );
  });
});

void describe("discount, tax, and aggregate totals", () => {
  void test("rounds discount and tax at explicit currency boundaries", () => {
    assert.deepEqual(
      calculateLinePricing({
        quantity: 3,
        unitPrice: "19.99",
        discountPercent: "10",
        taxPercent: "8.25",
      }),
      {
        subtotal: "59.97",
        discount: "6.00",
        taxableAmount: "53.97",
        tax: "4.45",
        total: "58.42",
      }
    );
  });

  void test("handles zero percentages and adds order or invoice totals exactly", () => {
    const first = calculateLinePricing({ quantity: 1, unitPrice: "0.10" });
    const second = calculateLinePricing({ quantity: 2, unitPrice: "0.10" });
    assert.deepEqual(calculatePricingTotals([first, second]), {
      subtotal: "0.30",
      discount: "0.00",
      taxableAmount: "0.30",
      tax: "0.00",
      total: "0.30",
    });
    assert.equal(calculatePricingTotals([]).total, "0.00");
  });

  void test("rejects invalid discounts, tax, and rates", () => {
    assert.throws(
      () => calculateLinePricing({ quantity: 1, unitPrice: "10", discountPercent: "100.01" }),
      /must not exceed 100/
    );
    assert.throws(
      () => calculateLinePricing({ quantity: 1, unitPrice: "10", taxPercent: -1 }),
      /tax percent must be zero or greater/
    );
    assert.throws(() => productSubtotal("-0.01", 1), /unit price must be zero or greater/);
  });
});
