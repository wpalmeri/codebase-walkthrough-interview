import type { ComboDiscount, Product, Rate } from "@prisma/client";
import {
  ComboDiscountSchema,
  type ComboDiscount as ContractComboDiscount,
  RateSchema,
  type Rate as ContractRate,
} from "@meridian/contracts";
import { parseRateTiers } from "../domain/rateTier";
import {
  canonicalMoney,
  canonicalPercentage,
  canonicalQuantity,
  decimalOrLegacy,
  MONEY_PRECISION,
  MONEY_SCALE,
} from "../domain/money";

export type { RateTier } from "@meridian/contracts";
export type RateModel = ContractRate;
export type ComboDiscountModel = ContractComboDiscount;

export function toRateModel(row: Rate & { product?: Product }): RateModel {
  const tiers = parseRateTiers(row.tiers);
  return RateSchema.parse({
    id: row.id,
    customerId: row.customerId,
    productId: row.productId,
    productSku: row.product?.sku,
    productName: row.product?.name,
    unitPrice: row.unitPrice,
    unitPriceDecimal: decimalOrLegacy(
      { decimal: row.unitPriceDecimal, legacy: row.unitPrice },
      { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "rate unit price" }
    ),
    currencyCode: row.currencyCode ?? undefined,
    tiers,
    tiersDecimal: tiers.map((tier) => ({
      upTo: tier.upTo === null ? null : canonicalQuantity(tier.upTo, "tier upper bound"),
      unitPrice: canonicalMoney(tier.unitPrice, "tier unit price"),
      floor: tier.floor == null ? tier.floor : canonicalMoney(tier.floor, "tier floor"),
      ceiling: tier.ceiling == null ? tier.ceiling : canonicalMoney(tier.ceiling, "tier ceiling"),
    })),
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
    percentOffDecimal: row.percentOffDecimal
      ? canonicalPercentage(row.percentOffDecimal, "combo discount")
      : canonicalPercentage(row.percentOff, "combo discount"),
  });
}
