import { Router } from "express";
import * as rates from "../controllers/rateController";
import { h, optionalQueryString } from "./helpers";

export const ratesView = Router();

ratesView.get("/", h(async (req) => rates.listRates(optionalQueryString(req.query.customerId))));

ratesView.get(
  "/combos",
  h(async (req) => rates.listComboDiscounts(optionalQueryString(req.query.customerId)))
);

ratesView.post(
  "/combos",
  h(async (req) =>
    rates.createComboDiscount({
      name: req.body.name,
      productIds: req.body.productIds,
      percentOff: req.body.percentOff,
      customerId: req.body.customerId ?? null,
    })
  )
);

ratesView.put(
  "/:id",
  h(async (req) =>
    rates.updateRate(req.params.id, {
      unitPrice: req.body.unitPrice,
      tiers: req.body.tiers,
    })
  )
);
