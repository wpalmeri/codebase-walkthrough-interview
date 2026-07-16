import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";
import { shortToken } from "../lib/ids.js";
import { requirePolicy } from "../permissions/policy-service.js";

export async function createWebhookEndpoint(context: RequestContext, url: string, eventNames: string[]) {
  requirePolicy(context, "workflow.manage");
  return db.webhookEndpoint.create({
    data: {
      organizationId: context.organizationId,
      url,
      secret: `whsec_${shortToken(24)}`,
      eventNames: asJson(eventNames),
      createdBy: context.userId,
    },
  });
}

export async function listWebhookEndpoints(context: RequestContext) {
  const endpoints = await db.webhookEndpoint.findMany({ where: { organizationId: context.organizationId } });
  const rows = [];
  for (const endpoint of endpoints) {
    const deliveryCount = await db.webhookDelivery.count({ where: { endpointId: endpoint.id } });
    const failureCount = await db.webhookDelivery.count({ where: { endpointId: endpoint.id, status: "FAILED" } });
    rows.push({
      id: endpoint.id,
      url: endpoint.url,
      // Secret returned in full; the settings screen shows it verbatim.
      secret: endpoint.secret,
      eventNames: endpoint.eventNames,
      active: endpoint.active,
      deliveryCount,
      failureCount,
    });
  }
  return rows;
}

export async function recentDeliveries(context: RequestContext, limit = 50) {
  return db.webhookDelivery.findMany({
    where: { endpoint: { organizationId: context.organizationId } },
    include: { endpoint: { select: { url: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function toggleWebhookEndpoint(context: RequestContext, endpointId: string, active: boolean) {
  const endpoint = await db.webhookEndpoint.findFirst({ where: { id: endpointId, organizationId: context.organizationId } });
  if (!endpoint) throw new NotFoundError("Endpoint not found");
  return db.webhookEndpoint.update({ where: { id: endpointId }, data: { active } });
}
