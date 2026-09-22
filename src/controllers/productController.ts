import { prisma } from "../db";
import { ProductModel, toProductModel } from "../models/product";

/** Lists only products owned by the server-derived tenant principal. */
export async function listProducts(tenantId: string): Promise<ProductModel[]> {
  const rows = await prisma.product.findMany({
    where: { tenantId },
    orderBy: { sku: "asc" },
  });
  return rows.map(toProductModel);
}
