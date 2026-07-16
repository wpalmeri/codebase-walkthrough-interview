import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";

/**
 * Durable events consumed by the workflow runner and webhook dispatcher.
 * Callers may pass a transaction client; most don't, so the event row is
 * written (and can be picked up by the worker) before the business
 * transaction that produced it commits.
 */

type DbClient = Pick<typeof db, "domainEvent">;

export interface DomainEventInput {
  organizationId: string;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  emittedBy?: string;
}

export async function emitDomainEvent(input: DomainEventInput, client: DbClient = db) {
  return client.domainEvent.create({
    data: {
      organizationId: input.organizationId,
      eventName: input.eventName,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: asJson(input.payload) as Prisma.InputJsonValue,
      emittedBy: input.emittedBy,
    },
  });
}

export async function pendingEventCount(): Promise<number> {
  return db.domainEvent.count({ where: { processedAt: null } });
}
