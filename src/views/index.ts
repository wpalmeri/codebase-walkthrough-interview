import { Router } from "express";
import { customersView } from "./customersView";
import { invoicesView } from "./invoicesView";
import { ordersView } from "./ordersView";
import { paymentsView } from "./paymentsView";
import { productsView } from "./productsView";
import { ratesView } from "./ratesView";
import { reportsView } from "./reportsView";

export const api = Router();

api.use("/customers", customersView);
api.use("/products", productsView);
api.use("/rates", ratesView);
api.use("/orders", ordersView);
api.use("/invoices", invoicesView);
api.use("/payments", paymentsView);
api.use("/reports", reportsView);
