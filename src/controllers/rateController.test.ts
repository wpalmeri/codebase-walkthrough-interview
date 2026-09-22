import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalMoney, canonicalPercentage } from "../domain/money";
import { buildRateUpdateData, dualWritePercentage } from "./rateController";

void describe("rate dual-write boundary", () => {
  void test("writes matching legacy and exact rate values with string-backed tiers", () => {
    const update = buildRateUpdateData({
      unitPrice: "12.3456",
      tiers: [
        { upTo: "100", unitPrice: "12.3456", floor: "1.25", ceiling: "500" },
      ],
    });

    assert.equal(update.unitPriceDecimal, "12.3456");
    assert.equal(canonicalMoney(update.unitPrice), update.unitPriceDecimal);
    assert.deepEqual(update.tiers, [
      {
        upTo: "100.000000",
        unitPrice: "12.3456",
        floor: "1.2500",
        ceiling: "500.0000",
      },
    ]);

    const discount = dualWritePercentage("7.5");
    assert.equal(discount.decimal, "7.5000");
    assert.equal(canonicalPercentage(discount.legacy), discount.decimal);
  });

  void test("rejects values that cannot be represented by both persistence columns", () => {
    assert.throws(() => buildRateUpdateData({ unitPrice: 1.00001 }), /at most 4 decimal places/);
    assert.throws(() => dualWritePercentage(100.0001), /must not exceed 100/);
  });

});
