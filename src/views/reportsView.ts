import { RevenueReportRequestSchema, type RevenueReportRequest } from "@meridian/contracts";
import { Router } from "express";
import { READ_ROLES, requireRole } from "../auth/authorization";
import * as reports from "../controllers/reportController";
import { h, validateRequest } from "./helpers";

export const reportsView = Router();

function period(request: RevenueReportRequest) {
  return request.query;
}

reportsView.get(
  "/revenue-by-quarter",
  h(async (req) =>
    reports.revenueByQuarter(
      requireRole(req, READ_ROLES).tenantId,
      period(validateRequest(RevenueReportRequestSchema, req))
    )
  )
);

reportsView.get(
  "/revenue-by-customer",
  h(async (req) =>
    reports.revenueByCustomer(
      requireRole(req, READ_ROLES).tenantId,
      period(validateRequest(RevenueReportRequestSchema, req))
    )
  )
);

reportsView.get(
  "/annual-revenue",
  h(async (req) =>
    reports.annualRevenue(
      requireRole(req, READ_ROLES).tenantId,
      period(validateRequest(RevenueReportRequestSchema, req))
    )
  )
);
