import {
  AnnualRevenueSchema,
  CustomerRevenueSchema,
  QuarterRevenueSchema,
  RevenueReportRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { READ_ROLES } from "../auth/authorization";
import * as reports from "../controllers/reportController";
import { defineOperation, mountOperation } from "../openapi/operation";

const revenueByQuarterOperation = defineOperation({
  method: "get",
  path: "/reports/revenue-by-quarter",
  operationId: "revenueByQuarter",
  summary: "Summarize recognized revenue by quarter",
  request: RevenueReportRequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Tenant-scoped quarterly recognized revenue in exact decimal strings",
    schema: QuarterRevenueSchema.array(),
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  handler: async ({ input, principal }) => reports.revenueByQuarter(principal.tenantId, input.query),
});

const revenueByCustomerOperation = defineOperation({
  method: "get",
  path: "/reports/revenue-by-customer",
  operationId: "revenueByCustomer",
  summary: "Summarize recognized revenue by customer",
  request: RevenueReportRequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Tenant-scoped customer recognized revenue in exact decimal strings",
    schema: CustomerRevenueSchema.array(),
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  handler: async ({ input, principal }) => reports.revenueByCustomer(principal.tenantId, input.query),
});

const annualRevenueOperation = defineOperation({
  method: "get",
  path: "/reports/annual-revenue",
  operationId: "annualRevenue",
  summary: "Summarize recognized revenue by year",
  request: RevenueReportRequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Tenant-scoped annual recognized revenue in exact decimal strings",
    schema: AnnualRevenueSchema.array(),
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  handler: async ({ input, principal }) => reports.annualRevenue(principal.tenantId, input.query),
});

/** Reused by the OpenAPI inventory; these descriptors are what Express mounts. */
export const reportOperations = [
  revenueByQuarterOperation,
  revenueByCustomerOperation,
  annualRevenueOperation,
] as const;

export const reportsView = Router();
for (const operation of reportOperations) mountOperation(reportsView, operation);
