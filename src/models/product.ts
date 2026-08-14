import type { Product } from "@prisma/client";

export interface ProductModel {
  id: string;
  sku: string;
  name: string;
  unit: string;
  listPrice: number;
}

export function toProductModel(row: Product): ProductModel {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    listPrice: row.listPrice,
  };
}
