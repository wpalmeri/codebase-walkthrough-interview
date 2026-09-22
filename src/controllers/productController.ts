import { prisma } from "../db";
import { ProductModel, toProductModel } from "../models/product";
import {
  ProductPageSchema,
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
  parsePaginationCursor,
  type ListProductsV1Request,
  type PaginationCursorFailureCode,
  type ProductPage,
} from "@meridian/contracts";
import { z } from "zod";

/** Lists only products owned by the server-derived tenant principal. */
export async function listProducts(tenantId: string): Promise<ProductModel[]> {
  const rows = await prisma.product.findMany({
    where: { tenantId },
    orderBy: { sku: "asc" },
  });
  return rows.map(toProductModel);
}

const ProductCursorOrderingSchema = z.tuple([
  z.string().min(1).max(1_024),
  z.string().min(1).max(1_024),
]);

export type ProductPageResult =
  | { readonly ok: true; readonly page: ProductPage }
  | { readonly ok: false; readonly code: PaginationCursorFailureCode };

/**
 * Lists a v1 tenant-scoped product page in ascending `(sku, id)` order. The
 * explicit id tie-breaker keeps the cursor deterministic if SKU uniqueness is
 * later relaxed to tenant scope without changing this wire contract.
 */
export async function listProductsPage(
  tenantId: string,
  query: ListProductsV1Request["query"]
): Promise<ProductPageResult> {
  // The opaque SHA-256 fingerprint binds the cursor to server-derived tenant
  // identity without placing that identity in the cursor payload.
  const filterFingerprint = fingerprintTenantPaginationBinding({}, tenantId);
  const parsedCursor = query.cursor === undefined
    ? undefined
    : parsePaginationCursor(query.cursor, { resource: "products", filterFingerprint });
  if (parsedCursor !== undefined && !parsedCursor.ok) return parsedCursor;

  const ordering = parsedCursor === undefined
    ? undefined
    : ProductCursorOrderingSchema.safeParse(parsedCursor.ordering);
  if (ordering !== undefined && !ordering.success) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }

  const [sku, id] = ordering === undefined ? [] : ordering.data;
  const rows = await prisma.product.findMany({
    where: {
      tenantId,
      ...(sku === undefined || id === undefined
        ? {}
        : {
            OR: [
              { sku: { gt: sku } },
              { sku, id: { gt: id } },
            ],
          }),
    },
    orderBy: [{ sku: "asc" }, { id: "asc" }],
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > query.limit && lastRow !== undefined
    ? formatPaginationCursor({
        resource: "products",
        filterFingerprint,
        ordering: [lastRow.sku, lastRow.id],
      })
    : null;
  return {
    ok: true,
    page: ProductPageSchema.parse({
      data: pageRows.map(toProductModel),
      page: { limit: query.limit, nextCursor },
    }),
  };
}
