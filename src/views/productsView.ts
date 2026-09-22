import { ListProductsRequestSchema } from "@meridian/contracts";
import { Router } from "express";
import * as products from "../controllers/productController";
import { h, validateRequest } from "./helpers";

export const productsView = Router();

productsView.get(
  "/",
  h(async (req) => {
    validateRequest(ListProductsRequestSchema, req);
    return products.listProducts();
  })
);
