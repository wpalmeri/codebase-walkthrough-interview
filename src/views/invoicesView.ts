import { Router } from "express";
import * as invoices from "../controllers/invoiceController";
import { h } from "./helpers";

export const invoicesView = Router();

invoicesView.get("/", h(async () => invoices.listInvoices()));

invoicesView.get("/:id", h(async (req) => invoices.getInvoice(req.params.id)));

invoicesView.put(
  "/:id",
  h(async (req) =>
    invoices.updateInvoice(req.params.id, {
      issueDate: req.body.issueDate,
      dueDate: req.body.dueDate,
    })
  )
);

invoicesView.post("/:id/post", h(async (req) => invoices.postInvoice(req.params.id)));

invoicesView.post(
  "/:id/send",
  h(async (req) => invoices.sendInvoice(req.params.id, req.body.method))
);

invoicesView.post(
  "/transmissions/:transmissionId/refresh",
  h(async (req) => invoices.refreshTransmission(req.params.transmissionId))
);
