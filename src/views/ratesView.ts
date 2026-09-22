import {
  CreateComboDiscountRequestSchema,
  ListComboDiscountsRequestSchema,
  ListRatesRequestSchema,
  UpdateRateRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { ADMIN_ROLES, READ_ROLES, requireRole } from "../auth/authorization";
import * as rates from "../controllers/rateController";
import { h, validateRequest } from "./helpers";

export const ratesView = Router();

ratesView.get(
  "/",
  h(async (req) => {
    const { query } = validateRequest(ListRatesRequestSchema, req);
    return rates.listRates(requireRole(req, READ_ROLES).tenantId, query.customerId);
  })
);

ratesView.get(
  "/combos",
  h(async (req) => {
    const { query } = validateRequest(ListComboDiscountsRequestSchema, req);
    return rates.listComboDiscounts(requireRole(req, READ_ROLES).tenantId, query.customerId);
  })
);

ratesView.post(
  "/combos",
  h(async (req) => {
    const { body } = validateRequest(CreateComboDiscountRequestSchema, req);
    return rates.createComboDiscount(requireRole(req, ADMIN_ROLES).tenantId, {
      ...body,
      customerId: body.customerId ?? null,
    });
  })
);

ratesView.put(
  "/:id",
  h(async (req) => {
    const { params, body } = validateRequest(UpdateRateRequestSchema, req);
    return rates.updateRate(requireRole(req, ADMIN_ROLES).tenantId, params.id, body);
  })
);
