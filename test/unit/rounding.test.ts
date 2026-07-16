import { Prisma } from "@prisma/client";
import { roundPerUnit, roundFinalTotal, roundToWholeDollars } from "../../src/pricing/rounding.js";
import { toCents, fromCents, splitCents, percentOfCents } from "../../src/lib/money-cents.js";
import { credentialMultiplier } from "../../src/pricing/modifiers.js";

describe("rounding strategies", () => {
  it("rounds per unit versus final total, producing different cents on odd counts", () => {
    const unit = new Prisma.Decimal("38.335");
    const perUnit = roundPerUnit(unit, 3);
    const finalTotal = roundFinalTotal(unit, 3);
    // Rounding the unit first vs rounding the product can differ.
    expect(perUnit.toString()).not.toBe(finalTotal.toString());
  });

  it("rounds statements to whole dollars for the legacy mail format", () => {
    expect(roundToWholeDollars(new Prisma.Decimal("122.75")).toString()).toBe("123");
  });

  it("splits integer cents without losing a cent", () => {
    const parts = splitCents(100, 3);
    expect(parts.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("computes coinsurance in integer cents", () => {
    expect(percentOfCents(toCents("135.00"), 20)).toBe(2700);
    expect(fromCents(2700)).toBe(27);
  });

  it("applies credential modifiers to assistant credentials only", () => {
    expect(credentialMultiplier("RN")).toBe(1);
    expect(credentialMultiplier("LVN")).toBe(0.85);
    expect(credentialMultiplier(null)).toBe(1);
  });
});
