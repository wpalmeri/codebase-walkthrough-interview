import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { writeAudit } from "../audit/audit-service.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_PATIENT_MERGED } from "../events/event-names.js";
import { requirePolicy } from "../permissions/policy-service.js";

/**
 * Merges a duplicate patient into a survivor.
 *
 * Re-points visits, visit sets, episodes, coverages, and assignments. Claims,
 * statements, possible-match rows, and custom-field values still reference
 * the merged patient id, and Visit.patientId is re-pointed while the parent
 * VisitSet rows were already moved — historical reads that join through the
 * hierarchy see the survivor, direct reads of old claim rows do not.
 */
export async function mergePatients(context: RequestContext, survivorId: string, mergedId: string) {
  requirePolicy(context, "patient.merge");
  if (survivorId === mergedId) throw new ConflictError("Cannot merge a patient into itself");

  const survivor = await db.patient.findFirst({ where: { id: survivorId, organizationId: context.organizationId } });
  const merged = await db.patient.findFirst({ where: { id: mergedId, organizationId: context.organizationId } });
  if (!survivor || !merged) throw new NotFoundError("Patient not found");

  const movedVisits = await db.visit.updateMany({ where: { patientId: mergedId }, data: { patientId: survivorId } });
  const movedSets = await db.visitSet.updateMany({ where: { patientId: mergedId }, data: { patientId: survivorId } });
  const movedEpisodes = await db.careEpisode.updateMany({ where: { patientId: mergedId }, data: { patientId: survivorId } });
  const movedCoverages = await db.insuranceCoverage.updateMany({ where: { patientId: mergedId }, data: { patientId: survivorId } });
  await db.patientAssignment.updateMany({ where: { patientId: mergedId }, data: { patientId: survivorId } });

  await db.patient.update({ where: { id: mergedId }, data: { active: false, deletedAt: new Date() } });

  const record = await db.patientMerge.create({
    data: {
      organizationId: context.organizationId,
      survivorId,
      mergedId,
      mergedBy: context.userId,
      details: {
        movedVisits: movedVisits.count,
        movedSets: movedSets.count,
        movedEpisodes: movedEpisodes.count,
        movedCoverages: movedCoverages.count,
      },
    },
  });

  await writeAudit(context.organizationId, context.userId, "patient.merged", "Patient", survivorId, {
    mergedId,
    mergeRecordId: record.id,
  });
  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_PATIENT_MERGED,
    aggregateType: "Patient",
    aggregateId: survivorId,
    payload: { survivorId, mergedId },
    emittedBy: context.userId,
  });

  return record;
}
