import { prisma } from "../db";
import { ProductModel, toProductModel } from "../models/product";
import {
  ProductPageSchema,
  fingerprintPaginationFilters,
  formatPaginationCursor,
  parsePaginationCursor,
  type ListProductsV1Request,
  type PaginationCursorFailureCode,
  type ProductPage,
} from "@meridian/contracts";
import { z } from "zod";

/** Lists the shared company catalog. */
export async function listProducts(): Promise<ProductModel[]> {
  const rows = await prisma.product.findMany({
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
 * Lists a v1 global product page in ascending `(sku, id)` order.
 */
export async function listProductsPage(
  query: ListProductsV1Request["query"]
): Promise<ProductPageResult> {
  const filterFingerprint = fingerprintPaginationFilters({});
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
    where: sku === undefined || id === undefined
      ? {}
      : {
          OR: [
            { sku: { gt: sku } },
            { sku, id: { gt: id } },
          ],
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
