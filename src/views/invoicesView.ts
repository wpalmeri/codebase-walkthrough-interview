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
import { requestAuditMetadata } from "../audit/requestAudit";
import { isV1Request } from "../http/apiVersion";
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
  h(async (req, response) => {
    const { params } = validateRequest(GetInvoiceRequestSchema, req);
    const result = await invoices.getVersionedInvoice(requireRole(req, READ_ROLES).tenantId, params.id);
    if (isV1Request(req)) response.setHeader("ETag", result.etag);
    return result.invoice;
  })
);

const updateInvoice = h(async (req, response) => {
  const { params, body } = validateRequest(UpdateInvoiceRequestSchema, req);
  const principal = requireRole(req, BILLING_WRITE_ROLES);
  const audit = {
    metadata: requestAuditMetadata(req, principal),
  };
  if (!isV1Request(req)) return invoices.updateInvoice(principal.tenantId, params.id, body, audit);
  const result = await invoices.updateInvoiceConditionally(principal.tenantId, params.id, body, req.get("if-match"), audit);
  response.setHeader("ETag", result.etag);
  return result.invoice;
});

invoicesView.put("/:id", updateInvoice);
invoicesView.patch("/:id", updateInvoice);

invoicesView.post(
  "/:id/post",
  h(async (req) => {
    const { params } = validateRequest(PostInvoiceRequestSchema, req);
    const principal = requireRole(req, BILLING_WRITE_ROLES);
    return invoices.postInvoice(principal.tenantId, params.id, {
      metadata: requestAuditMetadata(req, principal),
    });
  })
);

invoicesView.post(
  "/:id/send",
  h(async (req) => {
    const { params, body } = validateRequest(SendInvoiceRequestSchema, req);
    const principal = requireRole(req, BILLING_WRITE_ROLES);
    return invoices.sendInvoice(principal.tenantId, params.id, body.method, {
      metadata: requestAuditMetadata(req, principal),
    });
  })
);

invoicesView.post(
  "/transmissions/:transmissionId/refresh",
  h(async (req) => {
    const { params } = validateRequest(RefreshTransmissionRequestSchema, req);
    const principal = requireRole(req, BILLING_WRITE_ROLES);
    return invoices.refreshTransmission(
      principal.tenantId,
      params.transmissionId,
      { metadata: requestAuditMetadata(req, principal) }
    );
  })
);
