import { Prisma } from "@prisma/client";

// Three rounding strategies coexist. Charge creation rounds per unit,
// claim generation rounds the final total, and statements round to whole
// dollars for one customer. Comparisons across modules differ by cents.

export function roundPerUnit(unitPrice: Prisma.Decimal, units: number): Prisma.Decimal {
  const rounded = unitPrice.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return rounded.times(units).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function roundFinalTotal(unitPrice: Prisma.Decimal, units: number): Prisma.Decimal {
  return unitPrice.times(units).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_EVEN);
}

export function roundToWholeDollars(amount: Prisma.Decimal): Prisma.Decimal {
  return amount.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
}
