import { VisitStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_AUTH_NEAR_LIMIT } from "../events/event-names.js";
import { countsCancelledVisitsAgainstAuth } from "../config/customer-overrides.js";

/**
 * Authorization utilization and enforcement.
 *
 * Three different "used" numbers live here:
 *  - authorizedVisitsUsed: scheduled + in-progress + completed, any date
 *  - usedVisitsInWindow:   completed only, inside the auth window
 *  - deliveredUnits:       completed visit *groups* (pre-pivot definition)
 * Enforcement reads the first; the UI badge shows the second; the utilization
 * report shows the third.
 */

export async function authorizedVisitsUsed(visitSetId: string): Promise<number> {
  const set = await db.visitSet.findUniqueOrThrow({ where: { id: visitSetId }, include: { organization: true } });
  const statuses: VisitStatus[] = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED];
  if (countsCancelledVisitsAgainstAuth(set.organization.slug)) statuses.push(VisitStatus.CANCELLED);
  return db.visit.count({
    where: { visitGroup: { visitSetId }, status: { in: statuses }, deletedAt: null },
  });
}

export async function usedVisitsInWindow(visitSetId: string): Promise<number> {
  const set = await db.visitSet.findUniqueOrThrow({ where: { id: visitSetId }, include: { authorization: true } });
  if (!set.authorization) return 0;
  return db.visit.count({
    where: {
      visitGroup: { visitSetId },
      status: VisitStatus.COMPLETED,
      scheduledStart: { gte: set.authorization.effectiveFrom, lte: set.authorization.effectiveTo },
      deletedAt: null,
    },
  });
}

export async function deliveredUnits(visitSetId: string): Promise<number> {
  return db.visitGroup.count({ where: { visitSetId, status: "COMPLETED", deletedAt: null } });
}

/**
 * Pre-scheduling gate. Counts, compares, and returns; the caller creates the
 * visit afterwards in its own statement. Two schedulers racing past this
 * check both consume the final authorized visit (INC-1042).
 */
export async function assertVisitAllowed(visitSetId: string): Promise<{ used: number; maximum: number | null }> {
  const set = await db.visitSet.findUnique({ where: { id: visitSetId }, include: { authorization: true } });
  if (!set) throw new NotFoundError("Visit set not found");
  const maximum = set.authorization?.maxVisits ?? null;
  const used = await authorizedVisitsUsed(visitSetId);
  if (maximum !== null && used >= maximum) {
    throw new ConflictError(`Authorization ${set.authorization?.authorizationNumber} has no remaining visits`);
  }
  if (maximum !== null && used === maximum - 1) {
    await emitDomainEvent({
      organizationId: set.organizationId,
      eventName: EVENT_AUTH_NEAR_LIMIT,
      aggregateType: "Authorization",
      aggregateId: set.authorizationId ?? visitSetId,
      payload: { visitSetId, used, maximum },
    });
  }
  return { used, maximum };
}

export async function authorizationSummary(visitSetId: string) {
  const set = await db.visitSet.findUnique({ where: { id: visitSetId }, include: { authorization: true } });
  if (!set) throw new NotFoundError("Visit set not found");
  const [enforcementUsed, windowUsed, groupUnits] = [
    await authorizedVisitsUsed(visitSetId),
    await usedVisitsInWindow(visitSetId),
    await deliveredUnits(visitSetId),
  ];
  return {
    authorizationNumber: set.authorization?.authorizationNumber ?? null,
    maxVisits: set.authorization?.maxVisits ?? null,
    authorizedVisitsUsed: enforcementUsed,
    usedVisitsInWindow: windowUsed,
    deliveredUnits: groupUnits,
    remaining: set.authorization ? set.authorization.maxVisits - enforcementUsed : null,
  };
}

export async function extendAuthorization(authorizationId: string, additionalVisits: number, newEndDate?: Date) {
  const authorization = await db.authorization.findUnique({ where: { id: authorizationId } });
  if (!authorization) throw new NotFoundError("Authorization not found");
  return db.authorization.update({
    where: { id: authorizationId },
    data: {
      maxVisits: authorization.maxVisits + additionalVisits,
      effectiveTo: newEndDate ?? authorization.effectiveTo,
    },
  });
}
