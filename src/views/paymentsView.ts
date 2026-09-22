import {
  ApplyPaymentRequestSchema,
  GetPaymentRequestSchema,
  ListPaymentsRequestSchema,
  RecordPaymentRequestSchema,
  ReversePaymentApplicationRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { BILLING_WRITE_ROLES, READ_ROLES, requireRole } from "../auth/authorization";
import * as payments from "../controllers/paymentController";
import { h, validateRequest } from "./helpers";

export const paymentsView = Router();

paymentsView.get(
  "/",
  h(async (req) => {
    validateRequest(ListPaymentsRequestSchema, req);
    return payments.listPayments(requireRole(req, READ_ROLES).tenantId);
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
