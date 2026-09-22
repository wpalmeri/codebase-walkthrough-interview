import {
  ApplyPaymentRequestSchema,
  GetPaymentRequestSchema,
  ListPaymentsRequestSchema,
  ListPaymentsV1RequestSchema,
  RecordPaymentRequestSchema,
  ReversePaymentApplicationRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { BILLING_WRITE_ROLES, READ_ROLES, requireRole } from "../auth/authorization";
import * as payments from "../controllers/paymentController";
import { isV1Request } from "../http/apiVersion";
import { formatNextPageLink } from "../http/pagination";
import { h, RequestValidationError, validateRequest } from "./helpers";

export const paymentsView = Router();

paymentsView.get(
  "/",
  h(async (req, response) => {
    const tenantId = requireRole(req, READ_ROLES).tenantId;
    if (!isV1Request(req)) {
      validateRequest(ListPaymentsRequestSchema, req);
      return payments.listPayments(tenantId);
    }

    const { query } = validateRequest(ListPaymentsV1RequestSchema, req);
    const page = await payments.listPaymentsPage(tenantId, query);
    if (!page.ok) {
      throw new RequestValidationError([
        {
          code: page.code,
          path: "query.cursor",
          message: "Cursor is invalid for this payment query",
        },
      ]);
    }
    const link = formatNextPageLink(req.originalUrl, page.page.page.nextCursor);
    if (link !== undefined) response.append("Link", link);
    return page.page;
  })
);

paymentsView.get(
  "/:id",
  h(async (req) => {
    const { params } = validateRequest(GetPaymentRequestSchema, req);
    return payments.getPayment(requireRole(req, READ_ROLES).tenantId, params.id);
  })
);

// Recording a payment and applying it are separate steps.
paymentsView.post(
  "/",
  h(async (req) => {
    const { body } = validateRequest(RecordPaymentRequestSchema, req);
    return payments.recordPayment(requireRole(req, BILLING_WRITE_ROLES).tenantId, body);
  })
);

paymentsView.post(
  "/:id/applications/:applicationId/reversals",
  h(async (req, res) => {
    const { params, body } = validateRequest(
      ReversePaymentApplicationRequestSchema,
      req
    );
    const reversal = await payments.reversePaymentApplication(
      requireRole(req, BILLING_WRITE_ROLES).tenantId,
      params.id,
      params.applicationId,
      body
    );
    res.status(201);
    return reversal;
  })
);

paymentsView.post(
  "/:id/apply",
  h(async (req) => {
    const { params, body } = validateRequest(ApplyPaymentRequestSchema, req);
    return payments.applyPayment(
      requireRole(req, BILLING_WRITE_ROLES).tenantId,
      params.id,
      body.applications
    );
  })
);
