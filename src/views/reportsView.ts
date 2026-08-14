import { Router } from "express";
import * as reports from "../controllers/reportController";
import { h } from "./helpers";

export const reportsView = Router();

function period(req: { query: Record<string, unknown> }) {
  return {
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  };
}

reportsView.get("/revenue-by-quarter", h(async (req) => reports.revenueByQuarter(period(req))));

reportsView.get("/revenue-by-customer", h(async (req) => reports.revenueByCustomer(period(req))));

reportsView.get("/annual-revenue", h(async (req) => reports.annualRevenue(period(req))));
