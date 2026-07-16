import { db } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";
import { legacyVisitPrice } from "../pricing/legacy-price-resolver.js";
import { billingReadiness } from "../revenue-cycle/billing-readiness.js";
import { authorizationSummary } from "../orders/authorization-service.js";

/**
 * Visit drawer payload. Loads the entire clinical/billing graph in one
 * include tree, re-derives pricing and readiness inline, and returns most of
 * it to the browser (patient demographics and full note content included).
 */
export async function visitDetail(visitId: string) {
  const visit = await db.visit.findUnique({
    where: { id: visitId },
    include: {
      patient: { include: { profile: true, demographics: true, coverages: { include: { payer: true } } } },
      visitGroup: {
        include: {
          branch: { include: { region: true } },
          visitSet: {
            include: {
              authorization: true,
              order: { include: { details: true, episode: true, requests: true } },
              patient: { include: { profile: true } },
            },
          },
          visits: { include: { notes: true } },
        },
      },
      notes: { include: { signatures: true, amendments: true } },
      charges: { include: { lines: { include: { claimLines: { include: { claim: true } } } } } },
      statusHistory: { orderBy: { changedAt: "desc" } },
    },
  });
  if (!visit) throw new NotFoundError("Visit not found");

  const [price, readiness, authorization] = [
    await legacyVisitPrice(visitId).catch(() => null),
    await billingReadiness(visitId).catch(() => null),
    await authorizationSummary(visit.visitGroup.visitSetId).catch(() => null),
  ];

  const claims = visit.charges
    .flatMap((charge) => charge.lines.flatMap((line) => line.claimLines.map((claimLine) => claimLine.claim)))
    .filter((claim, index, all) => all.findIndex((candidate) => candidate.id === claim.id) === index);

  return {
    visit: {
      id: visit.id,
      status: visit.status,
      serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
      scheduledStart: visit.scheduledStart,
      scheduledEnd: visit.scheduledEnd,
      actualStart: visit.actualStart,
      actualEnd: visit.actualEnd,
      completedAt: visit.completedAt,
      cancelledAt: visit.cancelledAt,
      cancellationReason: visit.cancellationReason,
      locationId: visit.locationId,
      clinicianId: visit.clinicianId,
    },
    hierarchy: {
      visitSetId: visit.visitGroup.visitSetId,
      visitGroupId: visit.visitGroupId,
      groupSequence: visit.visitGroup.sequenceNumber,
      siblingVisitIds: visit.visitGroup.visits.map((sibling) => sibling.id),
      setPatientId: visit.visitGroup.visitSet.patientId,
      visitPatientId: visit.patientId,
      patientMismatch: visit.patientId !== visit.visitGroup.visitSet.patientId,
      setCoverageId: visit.visitGroup.visitSet.coverageId,
      visitCoverageId: visit.coverageId,
      branch: { id: visit.visitGroup.branchId, name: visit.visitGroup.branch.name, region: visit.visitGroup.branch.region?.name ?? null },
    },
    patient: visit.patient,
    order: visit.visitGroup.visitSet.order,
    authorization,
    documentation: {
      groupStatus: visit.visitGroup.documentationStatus,
      notes: visit.notes,
    },
    billing: {
      groupBillingStatus: visit.visitGroup.billingStatus,
      setBillingStatus: visit.visitGroup.visitSet.billingStatus,
      charges: visit.charges,
      claims,
      expectedPrice: price,
      readiness,
    },
    statusHistory: visit.statusHistory,
  };
}
