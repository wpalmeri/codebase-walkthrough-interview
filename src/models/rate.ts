import type { ComboDiscount, Product, Rate } from "@prisma/client";

export interface ComboProductModel {
  id: string;
  sku: string;
  name: string;
}

// A quantity interval of the rate schedule. Units falling inside the interval
// are billed at its unit price; the interval's charge is clamped between the
// optional floor and ceiling. The item's price is the blended result.
export interface RateTier {
  upTo: number | null; // upper bound of the interval; null = unbounded
  unitPrice: number;
  floor?: number | null; // minimum charge for the interval
  ceiling?: number | null; // maximum charge for the interval
}

export interface RateModel {
  id: string;
  customerId: string;
  productId: string;
  productSku?: string;
  productName?: string;
  unitPrice: number;
  tiers: RateTier[];
  effectiveDate: string;
}

export interface ComboDiscountModel {
  id: string;
  customerId: string | null; // null = global
  name: string;
  products: ComboProductModel[];
  percentOff: number;
}

export function toRateModel(row: Rate & { product?: Product }): RateModel {
  return {
    id: row.id,
    customerId: row.customerId,
    productId: row.productId,
    productSku: row.product?.sku,
    productName: row.product?.name,
    unitPrice: row.unitPrice,
    tiers: (row.tiers as unknown as RateTier[]) ?? [],
    effectiveDate: row.effectiveDate.toISOString(),
  };
}

export function toComboDiscountModel(
  row: ComboDiscount & { products?: Product[] }
): ComboDiscountModel {
  return {
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    products: (row.products ?? []).map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
    })),
    percentOff: row.percentOff,
  };
}
