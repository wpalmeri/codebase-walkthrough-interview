import type { Product } from "@prisma/client";
import { ProductSchema, type Product as ContractProduct } from "@meridian/contracts";
import { decimalOrLegacy, MONEY_PRECISION, MONEY_SCALE } from "../domain/money";

export type ProductModel = ContractProduct;

export function toProductModel(row: Product): ProductModel {
  return ProductSchema.parse({
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    listPrice: row.listPrice,
    listPriceDecimal: decimalOrLegacy(
      { decimal: row.listPriceDecimal, legacy: row.listPrice },
      { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "product list price" }
    ),
    currencyCode: row.currencyCode ?? undefined,
  });
}
