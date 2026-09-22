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
  h(async (req) => {
    const { params } = validateRequest(GetOrderRequestSchema, req);
    return orders.getOrder(requireRole(req, READ_ROLES).tenantId, params.id);
  })
);

ordersView.post(
  "/",
  h(async (req) => {
    const { body } = validateRequest(CreateOrderRequestSchema, req);
    return orders.createOrder(requireRole(req, BILLING_WRITE_ROLES).tenantId, body);
  })
);

const updateOrder = h(async (req) => {
  const { params, body } = validateRequest(UpdateOrderRequestSchema, req);
  return orders.saveOrder(requireRole(req, BILLING_WRITE_ROLES).tenantId, params.id, body);
});

ordersView.put("/:id", updateOrder);
ordersView.patch("/:id", updateOrder);

ordersView.post(
  "/:id/invoice",
  h(async (req) => {
    const { params } = validateRequest(CreateInvoiceForOrderRequestSchema, req);
    return invoices.createInvoiceForOrder(
      requireRole(req, BILLING_WRITE_ROLES).tenantId,
      params.id
    );
  })
);
