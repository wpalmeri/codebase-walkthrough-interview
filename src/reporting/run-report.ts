import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { asJson } from "../lib/json.js";
import { addDays } from "../lib/dates.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { track } from "../events/analytics.js";
import { REPORT_CATALOG } from "./report-catalog.js";
import { financialReportGate } from "./report-permissions.js";
import { operationsDashboard } from "./operations-report.js";
import { revenueReport } from "./revenue-report.js";
import { claimAging } from "./claim-aging-report.js";
import { cashReconciliationReport } from "./cash-report.js";
import { clinicianProductivity } from "./clinician-productivity.js";
import { authorizationUtilization } from "./authorization-report.js";
import { documentationBacklog } from "./documentation-report.js";
import { monthlyPatientCensus } from "./census-report.js";
import { pricingExport } from "./export-pricing.js";
import { branchAccessAudit } from "./branch-audit-report.js";
import { customVisitReport, unsafeEnterpriseExport } from "./custom-report.js";

export type ReportParams = Record<string, string | undefined>;

/** start/end default to the trailing 30 days; asOf defaults to now. */
function reportWindow(params: ReportParams): { start: Date; end: Date } {
  const end = params.end ? new Date(params.end) : new Date();
  const start = params.start ? new Date(params.start) : addDays(end, -30);
  return { start, end };
}

async function executeReport(context: RequestContext, key: string, params: ReportParams): Promise<unknown> {
  const { start, end } = reportWindow(params);
  const asOf = params.asOf ? new Date(params.asOf) : new Date();
  switch (key) {
    case "operations-dashboard":
      return operationsDashboard(context.organizationId, start, end);
    case "revenue-summary":
      return revenueReport(context.organizationId, start, end);
    case "claim-aging":
      return claimAging(context.organizationId, asOf);
    case "cash-reconciliation":
      return cashReconciliationReport(context.organizationId, start, end);
    case "clinician-productivity":
      return clinicianProductivity(context.organizationId, start, end);
    case "authorization-utilization":
      return authorizationUtilization(context.organizationId);
    case "documentation-backlog":
      return documentationBacklog(context.organizationId, asOf);
    case "monthly-census":
      return monthlyPatientCensus(context.organizationId, start, end);
    case "pricing-export":
      return pricingExport(context.organizationId);
    case "branch-audit": {
      if (!params.branchId) throw new ValidationError("branchId is required for the branch audit report");
      return branchAccessAudit(context.organizationId, params.branchId, start, end);
    }
    case "custom-visits":
      return customVisitReport(context, {
        start,
        end,
        branchIds: params.branchIds ? params.branchIds.split(",") : undefined,
        page: params.page ? Number(params.page) : undefined,
        pageSize: params.pageSize ? Number(params.pageSize) : undefined,
      });
    case "enterprise-export":
      return unsafeEnterpriseExport(context.organizationId);
    default:
      throw new NotFoundError(`No runner registered for report key: ${key}`);
  }
}

function extractRows(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return null;
}

/**
 * Catalog-driven report execution with a persisted ReportRun record.
 *
 * Financial entries are gated here. Note the direct app.ts routes and the
 * scheduled-export worker do not come through with a real user: the worker
 * runs everything as systemContext(org), which passes the gate for every
 * report. No statement timeout or row limit is applied; each report manages
 * its own bounds.
 */
export async function runReportByKey(context: RequestContext, key: string, params: ReportParams) {
  const entry = REPORT_CATALOG.find((candidate) => candidate.key === key);
  if (!entry) throw new NotFoundError(`Unknown report key: ${key}`);
  if (entry.financial) financialReportGate(context);
  for (const parameter of entry.parameters) {
    if (parameter.required && !params[parameter.name]) {
      throw new ValidationError(`Missing required parameter "${parameter.name}" for report ${key}`);
    }
  }

  const run = await db.reportRun.create({
    data: {
      organizationId: context.organizationId,
      reportKey: key,
      requestedBy: context.userId,
      parameters: asJson(params),
      status: "RUNNING",
    },
  });
  const startedAt = Date.now();
  try {
    const result = await executeReport(context, key, params);
    const rows = extractRows(result);
    const durationMs = Date.now() - startedAt;
    await db.reportRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        durationMs,
        rowCount: rows?.length ?? null,
        // First 20 rows are stored verbatim so support can debug a run
        // without re-executing it.
        resultSample: asJson(rows ? rows.slice(0, 20) : result),
      },
    });
    track("report.completed", { key, durationMs, rowCount: rows?.length ?? null }, { organizationId: context.organizationId, userId: context.userId });
    return { runId: run.id, key, rowCount: rows?.length ?? null, durationMs, result };
  } catch (error) {
    await db.reportRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function listRecentRuns(context: RequestContext, limit = 20) {
  return db.reportRun.findMany({
    where: { organizationId: context.organizationId },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      reportKey: true,
      definitionId: true,
      requestedBy: true,
      status: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
      rowCount: true,
      error: true,
    },
  });
}
