import { Router } from "express";
import * as invoices from "../controllers/invoiceController";
import * as orders from "../controllers/orderController";
import { h } from "./helpers";

export const ordersView = Router();

ordersView.get("/", h(async () => orders.listOrders()));

ordersView.get("/:id", h(async (req) => orders.getOrder(req.params.id)));

ordersView.post("/", h(async (req) => orders.createOrder(req.body)));

ordersView.put(
  "/:id",
  h(async (req) =>
    orders.saveOrder(req.params.id, {
      customerId: req.body.customerId,
      orderDate: req.body.orderDate,
      notes: req.body.notes,
      items: req.body.items,
      comment: req.body.comment,
    })
  )
);

ordersView.post(
  "/:id/invoice",
  h(async (req) => invoices.createInvoiceForOrder(req.params.id))
);
