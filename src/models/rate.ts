import type { ComboDiscount, Product, Rate } from "@prisma/client";
import { parseRateTiers } from "../domain/rateTier";
import type { RateTier } from "../domain/rateTier";

export type { RateTier } from "../domain/rateTier";

export interface ComboProductModel {
  id: string;
  sku: string;
  name: string;
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
    tiers: parseRateTiers(row.tiers),
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
