import {
  ApplyPaymentRequestSchema,
  GetPaymentRequestSchema,
  ListPaymentsRequestSchema,
  RecordPaymentRequestSchema,
  ReversePaymentApplicationRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import * as payments from "../controllers/paymentController";
import { h, validateRequest } from "./helpers";

export const paymentsView = Router();

paymentsView.get(
  "/",
  h(async (req) => {
    validateRequest(ListPaymentsRequestSchema, req);
    return payments.listPayments();
  })
);

paymentsView.get(
  "/:id",
  h(async (req) => {
    const { params } = validateRequest(GetPaymentRequestSchema, req);
    return payments.getPayment(params.id);
  })
);

// Recording a payment and applying it are separate steps.
paymentsView.post(
  "/",
  h(async (req) => {
    const { body } = validateRequest(RecordPaymentRequestSchema, req);
    return payments.recordPayment(body);
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
    return payments.applyPayment(params.id, body.applications);
  })
);
