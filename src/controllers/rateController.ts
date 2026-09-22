import { prisma } from "../db";
import {
  ComboDiscountModel,
  RateModel,
  toComboDiscountModel,
  toRateModel,
} from "../models/rate";
import {
  canonicalMoney,
  canonicalPercentage,
  legacyNumber,
  type DecimalInput,
} from "../domain/money";
import { serializeRateTiers, type RateTierInput } from "../domain/rateTier";
import { MoneyStringSchema, PercentageStringSchema, type MoneyString, type PercentageString } from "@meridian/contracts";

export interface DualWrittenMoney {
  readonly legacy: number;
  readonly decimal: MoneyString;
}

export interface DualWrittenPercentage {
  readonly legacy: number;
  readonly decimal: PercentageString;
}

/** Produces matching legacy and DECIMAL(19,4) values without rounding either write. */
export function dualWriteMoney(value: DecimalInput): DualWrittenMoney {
  const decimal = MoneyStringSchema.parse(canonicalMoney(value, "unit price"));
  return {
    legacy: legacyNumber(decimal, { scale: 4, precision: 19, field: "unit price" }),
    decimal,
  };
}

/** Produces matching legacy and DECIMAL(7,4) percentage values without rounding. */
export function dualWritePercentage(value: DecimalInput): DualWrittenPercentage {
  const decimal = PercentageStringSchema.parse(canonicalPercentage(value, "percent off"));
  return {
    legacy: legacyNumber(decimal, { scale: 4, precision: 7, field: "percent off" }),
    decimal,
  };
}

export interface RateUpdateData {
  readonly unitPrice: number;
  readonly unitPriceDecimal: MoneyString;
  readonly tiers?: ReturnType<typeof serializeRateTiers>;
}

/**
 * This intentionally builds only Rate columns. Callers use it as the update
 * boundary so rate changes cannot write or re-rate existing order snapshots.
 */
export function buildRateUpdateData(input: {
  unitPrice: DecimalInput;
  tiers?: RateTierInput[];
}): RateUpdateData {
  const price = dualWriteMoney(input.unitPrice);
  return {
    unitPrice: price.legacy,
    unitPriceDecimal: price.decimal,
    ...(input.tiers === undefined ? {} : { tiers: serializeRateTiers(input.tiers) }),
  };
}

export async function listRates(customerId?: string): Promise<RateModel[]> {
  const rows = await prisma.rate.findMany({
    where: customerId ? { customerId } : undefined,
    include: { product: true },
    orderBy: { effectiveDate: "asc" },
  });
  return rows.map(toRateModel);
}

// Combos scoped to the customer plus the global ones (customerId null).
export async function listComboDiscounts(customerId?: string): Promise<ComboDiscountModel[]> {
  const rows = await prisma.comboDiscount.findMany({
    where: customerId ? { OR: [{ customerId }, { customerId: null }] } : undefined,
    include: { products: true },
  });
  return rows.map(toComboDiscountModel);
}

export async function createComboDiscount(input: {
  name: string;
  productIds: string[];
  percentOff: DecimalInput;
  customerId?: string | null;
}): Promise<ComboDiscountModel> {
  const percentOff = dualWritePercentage(input.percentOff);
  const row = await prisma.comboDiscount.create({
    data: {
      name: input.name,
      percentOff: percentOff.legacy,
      percentOffDecimal: percentOff.decimal,
      customerId: input.customerId ?? null,
      products: { connect: (input.productIds ?? []).map((id) => ({ id })) },
    },
    include: { products: true },
  });
  return toComboDiscountModel(row);
}

// Update a customer's rate. Orders pick up the new price the next time they are
// re-rated (on save, or when an invoice is generated).
export async function updateRate(
  rateId: string,
  input: { unitPrice: DecimalInput; tiers?: RateTierInput[] }
): Promise<RateModel> {
  const rate = await prisma.rate.update({
    where: { id: rateId },
    data: buildRateUpdateData(input),
    include: { product: true },
  });
  return toRateModel(rate);
}
