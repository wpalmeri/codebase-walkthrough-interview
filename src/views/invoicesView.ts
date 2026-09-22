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
import { BILLING_WRITE_ROLES, READ_ROLES, requireRole } from "../auth/authorization";
import { h, validateRequest } from "./helpers";

export const invoicesView = Router();

invoicesView.get(
  "/",
  h(async (req) => {
    validateRequest(ListInvoicesRequestSchema, req);
    return invoices.listInvoices(requireRole(req, READ_ROLES).tenantId);
  })
);

invoicesView.get(
  "/:id",
  h(async (req) => {
    const { params } = validateRequest(GetInvoiceRequestSchema, req);
    return invoices.getInvoice(requireRole(req, READ_ROLES).tenantId, params.id);
  })
);

const updateInvoice = h(async (req) => {
  const { params, body } = validateRequest(UpdateInvoiceRequestSchema, req);
  return invoices.updateInvoice(requireRole(req, BILLING_WRITE_ROLES).tenantId, params.id, body);
});

invoicesView.put("/:id", updateInvoice);
invoicesView.patch("/:id", updateInvoice);

invoicesView.post(
  "/:id/post",
  h(async (req) => {
    const { params } = validateRequest(PostInvoiceRequestSchema, req);
    return invoices.postInvoice(requireRole(req, BILLING_WRITE_ROLES).tenantId, params.id);
  })
);

invoicesView.post(
  "/:id/send",
  h(async (req) => {
    const { params, body } = validateRequest(SendInvoiceRequestSchema, req);
    return invoices.sendInvoice(requireRole(req, BILLING_WRITE_ROLES).tenantId, params.id, body.method);
  })
);

invoicesView.post(
  "/transmissions/:transmissionId/refresh",
  h(async (req) => {
    const { params } = validateRequest(RefreshTransmissionRequestSchema, req);
    return invoices.refreshTransmission(
      requireRole(req, BILLING_WRITE_ROLES).tenantId,
      params.transmissionId
    );
  })
);
