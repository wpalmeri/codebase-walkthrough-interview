import { Router } from "express";
import * as reports from "../controllers/reportController";
import { h, optionalQueryString } from "./helpers";

export const reportsView = Router();

function period(req: { query: Record<string, unknown> }) {
  return {
    from: optionalQueryString(req.query.from),
    to: optionalQueryString(req.query.to),
  };
}

reportsView.get("/revenue-by-quarter", h(async (req) => reports.revenueByQuarter(period(req))));

reportsView.get("/revenue-by-customer", h(async (req) => reports.revenueByCustomer(period(req))));

reportsView.get("/annual-revenue", h(async (req) => reports.annualRevenue(period(req))));
