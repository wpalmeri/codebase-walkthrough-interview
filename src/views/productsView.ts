import { ListProductsRequestSchema, ProductSchema } from "@meridian/contracts";
import { Router } from "express";
import { READ_ROLES } from "../auth/authorization";
import * as products from "../controllers/productController";
import { defineOperation, mountOperation } from "../openapi/operation";

const listProductsOperation = defineOperation({
  method: "get",
  path: "/products",
  operationId: "listProducts",
  summary: "List catalog products",
  request: ListProductsRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Products visible to the tenant", schema: ProductSchema.array() },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 500],
  handler: async ({ principal }) => products.listProducts(principal.tenantId),
});

/** Reused by the document generator; these are the objects Express mounts. */
export const productOperations = [listProductsOperation] as const;

export const productsView = Router();
for (const operation of productOperations) mountOperation(productsView, operation);
