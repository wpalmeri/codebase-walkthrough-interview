import { prisma } from "../db";
import {
  ComboDiscountModel,
  RateModel,
  RateTier,
  toComboDiscountModel,
  toRateModel,
} from "../models/rate";

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
  percentOff: number;
  customerId?: string | null;
}): Promise<ComboDiscountModel> {
  const row = await prisma.comboDiscount.create({
    data: {
      name: input.name,
      percentOff: input.percentOff,
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
  input: { unitPrice: number; tiers?: RateTier[] }
): Promise<RateModel> {
  const rate = await prisma.rate.update({
    where: { id: rateId },
    data: {
      unitPrice: input.unitPrice,
      tiers: input.tiers !== undefined ? (input.tiers as object[]) : undefined,
    },
    include: { product: true },
  });
  return toRateModel(rate);
}
