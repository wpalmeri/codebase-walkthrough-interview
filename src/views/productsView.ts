import { ListProductsRequestSchema } from "@meridian/contracts";
import { Router } from "express";
import { READ_ROLES, requireRole } from "../auth/authorization";
import * as products from "../controllers/productController";
import { h, validateRequest } from "./helpers";

export const productsView = Router();

productsView.get(
  "/",
  h(async (req) => {
    validateRequest(ListProductsRequestSchema, req);
    return products.listProducts(requireRole(req, READ_ROLES).tenantId);
  })
);
