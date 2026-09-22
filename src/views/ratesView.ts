import {
  CreateComboDiscountRequestSchema,
  GetRateRequestSchema,
  ListComboDiscountsRequestSchema,
  ListRatesRequestSchema,
  UpdateRateRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { ADMIN_ROLES, READ_ROLES, requireRole } from "../auth/authorization";
import * as rates from "../controllers/rateController";
import { isV1Request } from "../http/apiVersion";
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

ratesView.get(
  "/:id",
  h(async (req, response) => {
    const { params } = validateRequest(GetRateRequestSchema, req);
    const result = await rates.getVersionedRate(requireRole(req, READ_ROLES).tenantId, params.id);
    // The representation itself remains compatible. Version one adds the
    // strong response header that its write contract requires.
    if (isV1Request(req)) response.setHeader("ETag", result.etag);
    return result.rate;
  })
);

ratesView.put(
  "/:id",
  h(async (req, response) => {
    const { params, body } = validateRequest(UpdateRateRequestSchema, req);
    const tenantId = requireRole(req, ADMIN_ROLES).tenantId;
    if (!isV1Request(req)) return rates.updateRate(tenantId, params.id, body);

    const result = await rates.updateRateConditionally(tenantId, params.id, body, req.get("if-match"));
    // `h` sends the representation after this closure resolves, preserving the
    // normal JSON response path while exposing the new representation tag.
    response.setHeader("ETag", result.etag);
    return result.rate;
  })
);
