import {
  ApplyPaymentRequestSchema,
  GetPaymentRequestSchema,
  ListPaymentsRequestSchema,
  RecordPaymentRequestSchema,
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
  "/:id/apply",
  h(async (req) => {
    const { params, body } = validateRequest(ApplyPaymentRequestSchema, req);
    return payments.applyPayment(params.id, body.applications);
  })
);
