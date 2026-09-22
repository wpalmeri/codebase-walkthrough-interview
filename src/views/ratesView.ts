import {
  CreateComboDiscountRequestSchema,
  ListComboDiscountsRequestSchema,
  ListRatesRequestSchema,
  UpdateRateRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import * as rates from "../controllers/rateController";
import { h, validateRequest } from "./helpers";

export const ratesView = Router();

ratesView.get(
  "/",
  h(async (req) => {
    const { query } = validateRequest(ListRatesRequestSchema, req);
    return rates.listRates(query.customerId);
  })
);

ratesView.get(
  "/combos",
  h(async (req) => {
    const { query } = validateRequest(ListComboDiscountsRequestSchema, req);
    return rates.listComboDiscounts(query.customerId);
  })
);

ratesView.post(
  "/combos",
  h(async (req) => {
    const { body } = validateRequest(CreateComboDiscountRequestSchema, req);
    return rates.createComboDiscount({
      ...body,
      customerId: body.customerId ?? null,
    });
  })
);

ratesView.put(
  "/:id",
  h(async (req) => {
    const { params, body } = validateRequest(UpdateRateRequestSchema, req);
    return rates.updateRate(params.id, body);
  })
);
