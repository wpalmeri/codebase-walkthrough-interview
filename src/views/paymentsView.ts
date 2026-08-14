import { Router } from "express";
import * as payments from "../controllers/paymentController";
import { h } from "./helpers";

export const paymentsView = Router();

paymentsView.get("/", h(async () => payments.listPayments()));

paymentsView.get("/:id", h(async (req) => payments.getPayment(req.params.id)));

// Recording a payment and applying it are separate steps.
paymentsView.post(
  "/",
  h(async (req) =>
    payments.recordPayment({
      customerId: req.body.customerId,
      amount: req.body.amount,
      reference: req.body.reference,
    })
  )
);

paymentsView.post(
  "/:id/apply",
  h(async (req) => payments.applyPayment(req.params.id, req.body.applications ?? []))
);
