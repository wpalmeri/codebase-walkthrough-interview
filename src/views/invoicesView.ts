import {
  GetInvoiceRequestSchema,
  ListInvoicesRequestSchema,
  PostInvoiceRequestSchema,
  RefreshTransmissionRequestSchema,
  SendInvoiceRequestSchema,
  UpdateInvoiceRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import * as invoices from "../controllers/invoiceController";
import { h, validateRequest } from "./helpers";

export const invoicesView = Router();

invoicesView.get(
  "/",
  h(async (req) => {
    validateRequest(ListInvoicesRequestSchema, req);
    return invoices.listInvoices();
  })
);

invoicesView.get(
  "/:id",
  h(async (req) => {
    const { params } = validateRequest(GetInvoiceRequestSchema, req);
    return invoices.getInvoice(params.id);
  })
);

const updateInvoice = h(async (req) => {
  const { params, body } = validateRequest(UpdateInvoiceRequestSchema, req);
  return invoices.updateInvoice(params.id, body);
});

invoicesView.put("/:id", updateInvoice);
invoicesView.patch("/:id", updateInvoice);

invoicesView.post(
  "/:id/post",
  h(async (req) => {
    const { params } = validateRequest(PostInvoiceRequestSchema, req);
    return invoices.postInvoice(params.id);
  })
);

invoicesView.post(
  "/:id/send",
  h(async (req) => {
    const { params, body } = validateRequest(SendInvoiceRequestSchema, req);
    return invoices.sendInvoice(params.id, body.method);
  })
);

invoicesView.post(
  "/transmissions/:transmissionId/refresh",
  h(async (req) => {
    const { params } = validateRequest(RefreshTransmissionRequestSchema, req);
    return invoices.refreshTransmission(params.transmissionId);
  })
);
