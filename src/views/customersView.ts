import { ListCustomersRequestSchema } from "@meridian/contracts";
import { Router } from "express";
import { READ_ROLES, requireRole } from "../auth/authorization";
import * as customers from "../controllers/customerController";
import { h, validateRequest } from "./helpers";

export const customersView = Router();

customersView.get(
  "/",
  h(async (req) => {
    validateRequest(ListCustomersRequestSchema, req);
    return customers.listCustomers(requireRole(req, READ_ROLES).tenantId);
  })
);
