import type { Product } from "@prisma/client";
import { ProductSchema, type Product as ContractProduct } from "@meridian/contracts";

export type ProductModel = ContractProduct;

export function toProductModel(row: Product): ProductModel {
  return ProductSchema.parse({
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    listPrice: row.listPrice,
  });
}
