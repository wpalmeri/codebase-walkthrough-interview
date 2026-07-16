import type { FastifyInstance } from "fastify";
import { contextFor } from "../request-context.js";
import { operationsDashboard, patientHeaderCounts } from "../../reporting/operations-report.js";
import { revenueReport } from "../../reporting/revenue-report.js";
import { authorizationUtilization } from "../../reporting/authorization-report.js";
import { documentationBacklog } from "../../reporting/documentation-report.js";
import { monthlyPatientCensus } from "../../reporting/census-report.js";
import { claimAging } from "../../reporting/claim-aging-report.js";
import { cashReconciliationReport } from "../../reporting/cash-report.js";
import { clinicianProductivity } from "../../reporting/clinician-productivity.js";
import { pricingExport } from "../../reporting/export-pricing.js";
import { customVisitReport, unsafeEnterpriseExport, runReportDefinition, saveReportDefinition } from "../../reporting/custom-report.js";
import { REPORT_CATALOG } from "../../reporting/report-catalog.js";
import { runReportByKey, listRecentRuns } from "../../reporting/run-report.js";
import { listScheduledExports, createScheduledExport, toggleScheduledExport } from "../../reporting/scheduled-exports.js";

function toDate(value: unknown): Date {
  return new Date(String(value));
}

export async function registerReportingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reports/catalog", async () => REPORT_CATALOG);
  app.get("/reports/runs", async (request) => listRecentRuns(await contextFor(request)));
  app.post("/reports/run/:key", async (request) => {
    const context = await contextFor(request);
    return runReportByKey(context, (request.params as { key: string }).key, (request.query as Record<string, string | undefined>) ?? {});
  });

  app.get("/reports/operations", async (request) => {
    const q = request.query as { organizationId: string; start: string; end: string };
    return operationsDashboard(q.organizationId, toDate(q.start), toDate(q.end));
  });
  app.get("/reports/revenue", async (request) => {
    const q = request.query as { organizationId: string; start: string; end: string };
    return revenueReport(q.organizationId, toDate(q.start), toDate(q.end));
  });
  app.get("/reports/authorizations", async (request) => authorizationUtilization((request.query as { organizationId: string }).organizationId));
  app.get("/reports/documentation", async (request) => {
    const q = request.query as { organizationId: string; asOf?: string };
    return documentationBacklog(q.organizationId, q.asOf ? toDate(q.asOf) : new Date());
  });
  app.get("/reports/census", async (request) => {
    const q = request.query as { organizationId: string; start: string; end: string };
    return monthlyPatientCensus(q.organizationId, toDate(q.start), toDate(q.end));
  });
  app.get("/reports/claim-aging", async (request) => {
    const q = request.query as { organizationId: string; asOf?: string };
    return claimAging(q.organizationId, q.asOf ? toDate(q.asOf) : new Date());
  });
  app.get("/reports/cash", async (request) => {
    const q = request.query as { organizationId: string; start: string; end: string };
    return cashReconciliationReport(q.organizationId, toDate(q.start), toDate(q.end));
  });
  app.get("/reports/clinician-productivity", async (request) => {
    const q = request.query as { organizationId: string; start: string; end: string };
    return clinicianProductivity(q.organizationId, toDate(q.start), toDate(q.end));
  });

  app.post("/reports/custom-visits", async (request) => {
    const input = request.body as { start: string; end: string; branchIds?: string[]; page?: number; pageSize?: number; columns?: string[] };
    return customVisitReport(await contextFor(request), { ...input, start: toDate(input.start), end: toDate(input.end) });
  });
  app.post("/reports/definitions", async (request) => saveReportDefinition(await contextFor(request), request.body as never));
  app.post("/reports/definitions/:id/run", async (request) => {
    const context = await contextFor(request);
    return runReportDefinition(context, (request.params as { id: string }).id, (request.query as Record<string, string | undefined>) ?? {});
  });

  app.get("/exports/enterprise", async (request) => unsafeEnterpriseExport((request.query as { organizationId: string }).organizationId));
  app.get("/exports/pricing", async (request) => pricingExport((request.query as { organizationId: string }).organizationId));

  app.get("/scheduled-exports", async (request) => listScheduledExports(await contextFor(request)));
  app.post("/scheduled-exports", async (request) => createScheduledExport(await contextFor(request), request.body as never));
  app.post("/scheduled-exports/:id/toggle", async (request) => {
    const input = request.body as { enabled: boolean };
    return toggleScheduledExport(await contextFor(request), (request.params as { id: string }).id, input.enabled);
  });

  app.get("/patients/:id/report-counts", async (request) => patientHeaderCounts((request.params as { id: string }).id));
}
