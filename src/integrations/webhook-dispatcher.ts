import { createHmac } from "node:crypto";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("webhook-dispatcher");

/**
 * Outbound webhook delivery.
 *
 * Signing uses HMAC-SHA256 over the JSON body with the endpoint secret, which
 * is fine — but secrets are stored in plaintext on WebhookEndpoint, retries
 * are capped at a fixed 3 with a constant backoff, and there is no dead-letter
 * beyond leaving the delivery row FAILED. Delivery happens inline when called
 * from a request; the job path retries by scanning FAILED rows.
 */

export interface EndpointLike {
  url: string;
  secret: string;
}

export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function deliverToEndpoint(endpoint: EndpointLike, eventName: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ eventName, payload });
  const signature = signPayload(endpoint.secret, body);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signature, "x-event": eventName },
      body,
    });
    return { delivered: response.ok, status: response.status };
  } catch (error) {
    log.warn({ url: endpoint.url, error: error instanceof Error ? error.message : String(error) }, "webhook delivery failed");
    return { delivered: false, status: 0 };
  }
}

export async function dispatchEvent(organizationId: string, eventName: string, payload: Record<string, unknown>) {
  const endpoints = await db.webhookEndpoint.findMany({ where: { organizationId, active: true } });
  const deliveries = [];
  for (const endpoint of endpoints) {
    const subscribed = Array.isArray(endpoint.eventNames) ? (endpoint.eventNames as string[]) : [];
    if (subscribed.length > 0 && !subscribed.includes(eventName)) continue;

    const delivery = await db.webhookDelivery.create({
      data: { endpointId: endpoint.id, eventName, payload: asJson(payload), status: "PENDING" },
    });
    const result = await deliverToEndpoint(endpoint, eventName, payload);
    deliveries.push(
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: result.delivered ? "DELIVERED" : "FAILED",
          attempts: 1,
          responseStatus: result.status,
          lastAttemptAt: new Date(),
          nextRetryAt: result.delivered ? null : new Date(Date.now() + 60_000),
        },
      }),
    );
  }
  return deliveries;
}

export async function retryFailedDeliveries(limit = 50) {
  const failures = await db.webhookDelivery.findMany({
    where: { status: "FAILED", attempts: { lt: 3 }, nextRetryAt: { lte: new Date() } },
    include: { endpoint: true },
    take: limit,
  });
  let retried = 0;
  for (const delivery of failures) {
    const result = await deliverToEndpoint(delivery.endpoint, delivery.eventName, delivery.payload as Record<string, unknown>);
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: result.delivered ? "DELIVERED" : "FAILED",
        attempts: { increment: 1 },
        responseStatus: result.status,
        lastAttemptAt: new Date(),
        nextRetryAt: result.delivered ? null : new Date(Date.now() + 60_000),
      },
    });
    retried += 1;
  }
  return { retried };
}
