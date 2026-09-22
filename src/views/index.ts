import { Router } from "express";
import { mountOperation } from "../openapi/operation";
import { customerOperations } from "./customersView";
import { invoiceOperations } from "./invoicesView";
import { orderOperations } from "./ordersView";
import { paymentOperations } from "./paymentsView";
import { productOperations } from "./productsView";
import { rateOperations } from "./ratesView";
import { reportOperations } from "./reportsView";
import { tenantApiKeyOperations } from "./tenantApiKeysView";
import { accountingPeriodOperations } from "./accountingPeriodsView";

/** The one inventory used to mount the API and publish its v1 contract. */
export const apiOperations = [
  ...customerOperations,
  ...productOperations,
  ...rateOperations,
  ...orderOperations,
  ...invoiceOperations,
  ...paymentOperations,
  ...reportOperations,
  ...tenantApiKeyOperations,
  ...accountingPeriodOperations,
] as const;

export const api = Router();
for (const operation of apiOperations) mountOperation(api, operation);
