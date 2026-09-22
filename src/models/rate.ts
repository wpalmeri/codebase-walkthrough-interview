import type { ComboDiscount, Product, Rate } from "@prisma/client";
import {
  ComboDiscountSchema,
  type ComboDiscount as ContractComboDiscount,
  RateSchema,
  type Rate as ContractRate,
} from "@meridian/contracts";
import { parseRateTiers } from "../domain/rateTier";

export type { RateTier } from "@meridian/contracts";
export type RateModel = ContractRate;
export type ComboDiscountModel = ContractComboDiscount;

export function toRateModel(row: Rate & { product?: Product }): RateModel {
  return RateSchema.parse({
    id: row.id,
    customerId: row.customerId,
    productId: row.productId,
    productSku: row.product?.sku,
    productName: row.product?.name,
    unitPrice: row.unitPrice,
    tiers: parseRateTiers(row.tiers),
    effectiveDate: row.effectiveDate.toISOString(),
  });
}

export function toComboDiscountModel(
  row: ComboDiscount & { products?: Product[] }
): ComboDiscountModel {
  return ComboDiscountSchema.parse({
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    products: (row.products ?? []).map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
    })),
    percentOff: row.percentOff,
  });
}
