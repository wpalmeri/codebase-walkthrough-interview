import { db } from "../lib/db.js";
import { registerJobHandler } from "./job-service.js";
import { processPendingEvents } from "../workflows/workflow-runner.js";
import { retryFailedDeliveries } from "../integrations/webhook-dispatcher.js";
import { syncRecentActivityToCrm } from "../integrations/crm-sync.js";
import { runDueExports } from "../reporting/scheduled-exports.js";
import { generateStatementBatch } from "../revenue-cycle/statement-service.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("job-handlers");

let registered = false;

/**
 * Registers background job handlers.
 *
 * These jobs run with no meaningful actor — several write audit rows with
 * actorId "system" or none — so audit exports can't attribute automated
 * changes to a person. The CRM sync job re-sends recent activity that the
 * inline path in visit completion may already have delivered.
 */
export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;

  registerJobHandler("process-events", async () => {
    const results = await processPendingEvents(100);
    return { processed: results.length };
  });

  registerJobHandler("retry-webhooks", async () => retryFailedDeliveries());

  registerJobHandler("crm-sync", async (payload) => {
    const organizationId = String(payload.organizationId ?? "");
    if (!organizationId) return { skipped: true };
    return syncRecentActivityToCrm(organizationId);
  });

  registerJobHandler("scheduled-exports", async () => runDueExports(new Date()));

  registerJobHandler("statement-batch", async (payload) => {
    const organizationId = String(payload.organizationId);
    const start = new Date(String(payload.start));
    const end = new Date(String(payload.end));
    return generateStatementBatch(organizationId, start, end, "worker");
  });

  registerJobHandler("clearinghouse-poll", async (payload) => {
    // Placeholder poller: marks submitted claims as accepted after a delay.
    const organizationId = String(payload.organizationId ?? "");
    const claims = await db.claim.findMany({ where: { organizationId, status: "SUBMITTED" }, take: 25 });
    for (const claim of claims) {
      await db.claim.update({ where: { id: claim.id }, data: { status: "ACCEPTED" } });
    }
    return { accepted: claims.length };
  });

  log.info("job handlers registered");
}
