import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  addDecimal,
  canonicalDecimal,
  canonicalMoney,
  canonicalPercentage,
  canonicalQuantity,
  compareDecimal,
  decimalOrLegacy,
  legacyNumber,
  subtractDecimal,
} from "./money";

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;

void describe("canonical financial decimal boundary", () => {
  void test("preserves decimal addition that binary floating point gets wrong", () => {
    assert.equal(addDecimal("0.1", "0.2", moneyFormat), "0.3000");
    assert.equal(addDecimal("0.1000", "0.2000", moneyFormat), "0.3000");
    assert.equal(compareDecimal("0.30", "0.3000", moneyFormat), 0);
    assert.equal(compareDecimal("0.3001", "0.30", moneyFormat), 1);
    assert.equal(subtractDecimal("1.0000", "0.3000", moneyFormat), "0.7000");
    assert.throws(() => subtractDecimal("0.3000", "1.0000", moneyFormat), /zero or greater/);
  });

  void test("returns a fixed canonical string at the requested scale without rounding", () => {
    assert.equal(canonicalMoney("00012.3"), "12.3000");
    assert.equal(canonicalQuantity("1.25"), "1.250000");
    assert.equal(canonicalPercentage("7.5"), "7.5000");
    assert.equal(canonicalDecimal("1.23000", { scale: 2, field: "tax" }), "1.23");
    assert.throws(
      () => canonicalDecimal("1.235", { scale: 2, field: "tax" }),
      /tax supports at most 2 decimal places/
    );
  });

  void test("accepts Prisma Decimal-like values and validates their actual precision", () => {
    const prismaDecimal = {
      toString: () => "12.3400",
    };
    assert.equal(canonicalMoney(prismaDecimal), "12.3400");
    assert.equal(canonicalMoney({ toString: () => "1.2e1" }), "12.0000");
    assert.throws(
      () => canonicalMoney({ toString: () => "1.00001" }),
      /amount supports at most 4 decimal places/
    );
  });

  void test("rejects invalid, negative, and column-overflow values at the boundary", () => {
    assert.equal(canonicalMoney(0), "0.0000");
    assert.throws(() => canonicalMoney(Number.NaN), /finite decimal/);
    assert.throws(() => canonicalMoney("1.2.3"), /must be a decimal/);
    assert.throws(() => canonicalMoney("-0.0001"), /zero or greater/);
    assert.throws(() => canonicalPercentage("100.0001"), /must not exceed 100/);
    assert.throws(() => canonicalMoney("1000000000000000"), /DECIMAL\(19,4\) precision/);
  });

  void test("uses the Decimal value before the legacy float and refuses corrupt Decimal fallback", () => {
    assert.equal(decimalOrLegacy({ decimal: "3.2500", legacy: 99.99 }, moneyFormat), "3.2500");
    assert.equal(decimalOrLegacy({ decimal: null, legacy: 0.1 }, moneyFormat), "0.1000");
    assert.throws(
      () => decimalOrLegacy({ decimal: "3.25001", legacy: 3.25 }, moneyFormat),
      /supports at most 4 decimal places/
    );
    assert.throws(() => decimalOrLegacy({ decimal: null, legacy: null }, moneyFormat), /required/);
  });

  void test("derives a legacy number only when the fixed decimal survives a round trip", () => {
    assert.equal(legacyNumber("0.1000", moneyFormat), 0.1);
    assert.equal(legacyNumber("12.3456", moneyFormat), 12.3456);
    assert.throws(
      () => legacyNumber("123456789012345.6789", moneyFormat),
      /cannot be represented safely as a legacy number/
    );
  });
});
