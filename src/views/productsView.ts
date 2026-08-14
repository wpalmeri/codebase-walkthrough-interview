import { Router } from "express";
import * as products from "../controllers/productController";
import { h } from "./helpers";

export const productsView = Router();

productsView.get("/", h(async () => products.listProducts()));
