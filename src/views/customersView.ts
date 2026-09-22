import { ListCustomersRequestSchema } from "@meridian/contracts";
import { Router } from "express";
import * as customers from "../controllers/customerController";
import { h, validateRequest } from "./helpers";

export const customersView = Router();

customersView.get(
  "/",
  h(async (req) => {
    validateRequest(ListCustomersRequestSchema, req);
    return customers.listCustomers();
  })
);
