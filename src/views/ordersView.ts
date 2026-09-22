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
import { h, validateRequest } from "./helpers";

export const ordersView = Router();

ordersView.get(
  "/",
  h(async (req) => {
    validateRequest(ListOrdersRequestSchema, req);
    return orders.listOrders();
  })
);

ordersView.get(
  "/:id",
  h(async (req) => {
    const { params } = validateRequest(GetOrderRequestSchema, req);
    return orders.getOrder(params.id);
  })
);

ordersView.post(
  "/",
  h(async (req) => {
    const { body } = validateRequest(CreateOrderRequestSchema, req);
    return orders.createOrder(body);
  })
);

const updateOrder = h(async (req) => {
  const { params, body } = validateRequest(UpdateOrderRequestSchema, req);
  return orders.saveOrder(params.id, body);
});

ordersView.put("/:id", updateOrder);
ordersView.patch("/:id", updateOrder);

ordersView.post(
  "/:id/invoice",
  h(async (req) => {
    const { params } = validateRequest(CreateInvoiceForOrderRequestSchema, req);
    return invoices.createInvoiceForOrder(params.id);
  })
);
