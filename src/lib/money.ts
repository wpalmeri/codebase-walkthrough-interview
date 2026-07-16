import { Prisma } from "@prisma/client";

type DecimalInput = string | number | Prisma.Decimal;

export function money(value: DecimalInput): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function multiplyMoney(unitPrice: DecimalInput, units: DecimalInput): Prisma.Decimal {
  return money(new Prisma.Decimal(unitPrice).times(units));
}

export function cents(value: DecimalInput): number {
  return money(value).times(100).toNumber();
}
