import { prisma } from "../db";
import { ProductModel, toProductModel } from "../models/product";

export async function listProducts(): Promise<ProductModel[]> {
  const rows = await prisma.product.findMany({ orderBy: { sku: "asc" } });
  return rows.map(toProductModel);
}
