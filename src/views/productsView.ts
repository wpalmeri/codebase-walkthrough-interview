import {
  ListProductsRequestSchema,
  ListProductsV1RequestSchema,
  ProductPageSchema,
  ProductSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { z } from "zod";
import { READ_ROLES } from "../auth/authorization";
import * as products from "../controllers/productController";
import { isV1Request } from "../http/apiVersion";
import { formatNextPageLink } from "../http/pagination";
import { PaginationResponseHeadersSchema, defineOperation, mountOperation } from "../openapi/operation";
import { RequestValidationError, validateRequest } from "./helpers";

const ProductListResponseSchema = z.union([ProductSchema.array(), ProductPageSchema]);

const listProductsOperation = defineOperation({
  method: "get",
  path: "/products",
  operationId: "listProducts",
  summary: "List catalog products",
  description:
    "`/api/v1` returns cursor-paginated products ordered by SKU then id; the legacy `/api` adapter remains an array.",
  request: ListProductsV1RequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Cursor-paginated product page",
    schema: ProductListResponseSchema,
    openApiSchema: ProductPageSchema,
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 500],
  responseHeaders: PaginationResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    if (!isV1Request(request)) {
      // The v1 contract is intentionally not accepted by legacy clients.
      validateRequest(ListProductsRequestSchema, request);
      return products.listProducts(principal.tenantId);
    }

    const page = await products.listProductsPage(principal.tenantId, input.query);
    if (!page.ok) {
      throw new RequestValidationError([
        {
          code: page.code,
          path: "query.cursor",
          message: "Cursor is invalid for this product query",
        },
      ]);
    }
    const link = formatNextPageLink(request.originalUrl, page.page.page.nextCursor);
    if (link !== undefined) response.append("Link", link);
    return page.page;
  },
});

/** Reused by the document generator; these are the objects Express mounts. */
export const productOperations = [listProductsOperation] as const;

export const productsView = Router();
for (const operation of productOperations) mountOperation(productsView, operation);
