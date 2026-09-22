import {
  CreateInvoiceForOrderRequestSchema,
  CreateOrderRequestSchema,
  GetOrderRequestSchema,
  ListOrdersRequestSchema,
  UpdateOrderRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import * as invoices from "../controllers/invoiceController";
import * as orders from "../controllers/orderController";
import { BILLING_WRITE_ROLES, READ_ROLES, requireRole } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import { isV1Request } from "../http/apiVersion";
import { h, validateRequest } from "./helpers";

export const ordersView = Router();

ordersView.get(
  "/",
  h(async (req) => {
    validateRequest(ListOrdersRequestSchema, req);
    return orders.listOrders(requireRole(req, READ_ROLES).tenantId);
  })
);

ordersView.get(
  "/:id",
  h(async (req, response) => {
    const { params } = validateRequest(GetOrderRequestSchema, req);
    const result = await orders.getVersionedOrder(requireRole(req, READ_ROLES).tenantId, params.id);
    if (isV1Request(req)) response.setHeader("ETag", result.etag);
    return result.order;
  })
);

ordersView.post(
  "/",
  h(async (req) => {
    const { body } = validateRequest(CreateOrderRequestSchema, req);
    const principal = requireRole(req, BILLING_WRITE_ROLES);
    return orders.createOrder(principal.tenantId, body, requestAuditMetadata(req, principal));
  })
);

const updateOrder = h(async (req, response) => {
  const { params, body } = validateRequest(UpdateOrderRequestSchema, req);
  const principal = requireRole(req, BILLING_WRITE_ROLES);
  const audit = requestAuditMetadata(req, principal);
  if (!isV1Request(req)) return orders.saveOrder(principal.tenantId, params.id, body, audit);

  const result = await orders.saveOrderConditionally(
    principal.tenantId,
    params.id,
    body,
    req.get("if-match"),
    audit
  );
  response.setHeader("ETag", result.etag);
  return result.order;
});

ordersView.put("/:id", updateOrder);
ordersView.patch("/:id", updateOrder);

ordersView.post(
  "/:id/invoice",
  h(async (req) => {
    const { params } = validateRequest(CreateInvoiceForOrderRequestSchema, req);
    const principal = requireRole(req, BILLING_WRITE_ROLES);
    return invoices.createInvoiceForOrder(
      principal.tenantId,
      params.id,
      { metadata: requestAuditMetadata(req, principal) }
    );
  })
);
