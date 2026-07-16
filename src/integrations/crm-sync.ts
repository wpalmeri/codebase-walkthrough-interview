import { env } from "../config/env.js";
import { db } from "../lib/db.js";
import { moduleLogger } from "../lib/logger.js";
import { asJson } from "../lib/json.js";

const log = moduleLogger("crm-sync");

/**
 * Pushes activity to the customer CRM. Called inline from visit completion
 * and branch moves (request latency includes this hop); the nightly job in
 * jobs/handlers re-sends anything the cursor thinks is missing, which
 * double-delivers whenever an inline call succeeded but the request that
 * made it later failed.
 */
export async function notifyCrmOfVisitActivity(
  organizationId: string,
  payload: { type: string; visitId: string; patientId: string; completedAt?: string },
): Promise<void> {
  try {
    const response = await fetch(env().crmUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": organizationId },
      body: JSON.stringify(payload),
    });
    if (!response.ok) log.warn({ status: response.status, visitId: payload.visitId }, "crm rejected activity");
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "crm notify failed");
  }
}

export async function syncRecentActivityToCrm(organizationId: string): Promise<{ sent: number }> {
  const state = await db.integrationSyncState.findUnique({
    where: { organizationId_integration: { organizationId, integration: "CRM" } },
  });
  const since = state?.lastSyncAt ?? new Date(Date.now() - 7 * 86_400_000);

  const visits = await db.visit.findMany({
    where: {
      completedAt: { gte: since },
      visitGroup: { visitSet: { organizationId } },
    },
    take: 200,
  });

  let sent = 0;
  for (const visit of visits) {
    await notifyCrmOfVisitActivity(organizationId, {
      type: "visit.completed",
      visitId: visit.id,
      patientId: visit.patientId,
      completedAt: visit.completedAt?.toISOString(),
    });
    sent += 1;
  }

  await db.integrationSyncState.upsert({
    where: { organizationId_integration: { organizationId, integration: "CRM" } },
    create: { organizationId, integration: "CRM", lastSyncAt: new Date(), state: asJson({ sent }) },
    update: { lastSyncAt: new Date(), state: asJson({ sent }) },
  });
  return { sent };
}
