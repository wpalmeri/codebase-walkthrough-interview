import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decimalDisplay, isPositiveMoney, money, sumMoney } from "./api";

void describe("exact client money helpers", () => {
  void test("formats canonical values without converting large amounts through Number", () => {
    assert.equal(money("900719925474099.0001"), "$900,719,925,474,099.00");
    assert.equal(money("1.0050"), "$1.01");
  });

  void test("sums binary-float-sensitive values exactly", () => {
    assert.equal(sumMoney(["0.1000", "0.2000"]), "0.3000");
    assert.equal(
      sumMoney(["900719925474099.0000", "0.0001"]),
      "900719925474099.0001"
    );
  });

  void test("compares exact zero without a numeric coercion", () => {
    assert.equal(isPositiveMoney("0.0000"), false);
    assert.equal(isPositiveMoney("0.0001"), true);
  });

  void test("trims display-only zeroes without changing the stored value", () => {
    assert.equal(decimalDisplay("3.000000"), "3");
    assert.equal(decimalDisplay("7.5000"), "7.5");
  });
});
