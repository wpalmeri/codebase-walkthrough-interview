import { Router } from "express";
import { customersView } from "./customersView";
import { invoicesView } from "./invoicesView";
import { ordersView } from "./ordersView";
import { paymentsView } from "./paymentsView";
import { productsView } from "./productsView";
import { ratesView } from "./ratesView";
import { reportsView } from "./reportsView";

export const api = Router();

// Catalog operation descriptors own their complete version-relative paths so
// the mounted route and generated OpenAPI path cannot disagree about a prefix.
api.use(customersView);
api.use(productsView);
api.use(ratesView);
api.use(ordersView);
api.use(invoicesView);
api.use(paymentsView);
api.use(reportsView);
