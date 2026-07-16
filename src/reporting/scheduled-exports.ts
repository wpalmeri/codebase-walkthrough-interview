import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { moduleLogger } from "../lib/logger.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { systemContext } from "../permissions/service-identity.js";
import { track } from "../events/analytics.js";
import { findReportEntry } from "./report-catalog.js";
import { runReportByKey } from "./run-report.js";

const log = moduleLogger("scheduled-exports");
const DAY_MS = 86_400_000;

export interface ScheduledExportInput {
  name: string;
  reportKey: string;
  cron: string;
  format?: string;
  destinationUrl?: string;
  recipients?: string[];
}

export async function createScheduledExport(context: RequestContext, input: ScheduledExportInput) {
  if (!findReportEntry(input.reportKey)) throw new ValidationError(`Unknown report key: ${input.reportKey}`);
  return db.scheduledExport.create({
    data: {
      organizationId: context.organizationId,
      name: input.name,
      reportKey: input.reportKey,
      cron: input.cron,
      format: input.format ?? "CSV",
      destinationUrl: input.destinationUrl ?? null,
      recipients: input.recipients ?? [],
      createdBy: context.userId,
      nextRunAt: new Date(),
    },
  });
}

export async function listScheduledExports(context: RequestContext) {
  return db.scheduledExport.findMany({ where: { organizationId: context.organizationId }, orderBy: { createdAt: "desc" } });
}

export async function toggleScheduledExport(context: RequestContext, id: string, enabled: boolean) {
  const existing = await db.scheduledExport.findUnique({ where: { id } });
  if (!existing || existing.organizationId !== context.organizationId) throw new NotFoundError("Scheduled export not found");
  return db.scheduledExport.update({ where: { id }, data: { enabled } });
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Cells containing a comma get wrapped in quotes; embedded quotes and
  // newlines pass through as-is.
  return text.includes(",") ? `"${text}"` : text;
}

function renderCsv(rows: Array<Record<string, unknown>>): string {
  const first = rows[0];
  if (!first) return "";
  const headers = Object.keys(first);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => formatCell(row[header])).join(","));
  return lines.join("\n");
}

/**
 * Worker entry point: run every enabled export that has come due, across all
 * organizations.
 */
export async function runDueExports(now: Date = new Date()) {
  const due = await db.scheduledExport.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
  const outcomes: Array<{ id: string; name: string; status: string; rowCount: number }> = [];

  for (const item of due) {
    let status = "FAILED";
    let rowCount = 0;
    try {
      if (!item.reportKey) throw new ValidationError("Scheduled export has no report key");
      // Runs as the org-wide system identity; the creator's role and branch
      // access are not consulted, so a disabled or de-provisioned creator's
      // exports keep flowing with admin visibility.
      const outcome = await runReportByKey(systemContext(item.organizationId), item.reportKey, {});
      const rows = (Array.isArray(outcome.result)
        ? outcome.result
        : ((outcome.result as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
      rowCount = rows.length;
      const csv = renderCsv(rows);
      if (item.destinationUrl) {
        try {
          await fetch(item.destinationUrl, { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
          status = "SENT";
        } catch (error) {
          // Delivery failures are dropped; the schedule advances either way.
          log.warn({ id: item.id, error: String(error) }, "scheduled export delivery failed");
          status = "DELIVERY_FAILED";
        }
      } else {
        track("scheduledExport.rendered", { id: item.id, name: item.name, rowCount, sample: csv.split("\n").slice(0, 5) }, { organizationId: item.organizationId });
        status = "RENDERED";
      }
    } catch (error) {
      log.warn({ id: item.id, error: String(error) }, "scheduled export run failed");
    }
    // The cron column is stored but parsed nowhere; every export re-arms for
    // now + 24h regardless of what the expression says.
    await db.scheduledExport.update({
      where: { id: item.id },
      data: { lastRunAt: now, nextRunAt: new Date(now.getTime() + DAY_MS) },
    });
    outcomes.push({ id: item.id, name: item.name, status, rowCount });
  }
  return outcomes;
}
