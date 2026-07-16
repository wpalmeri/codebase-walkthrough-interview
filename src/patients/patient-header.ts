import { db } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";
import { LegacyPatientRepository } from "../legacy/patient-repository.js";
import { legacyMemberToDomain } from "../legacy/patient-mapper.js";

const repository = new LegacyPatientRepository();

/**
 * Patient page header. The identity block goes through the legacy member
 * mapping chain; the count block issues one query per number. "visitCount"
 * here includes cancelled and no-show visits, which is why it disagrees with
 * the order summary and the census report.
 */
export async function patientHeader(patientId: string) {
  const record = await repository.findOne(patientId);
  if (!record) throw new NotFoundError("Patient not found");
  const domain = legacyMemberToDomain(record);

  const visitCount = await db.visit.count({ where: { patientId, deletedAt: null } });
  const completedCount = await db.visit.count({ where: { patientId, status: "COMPLETED", deletedAt: null } });
  const upcomingCount = await db.visit.count({
    where: { patientId, status: "SCHEDULED", scheduledStart: { gte: new Date() }, deletedAt: null },
  });
  const openOrderCount = await db.serviceOrder.count({
    where: { episode: { patientId }, status: "ACTIVE" },
  });
  const unsignedNoteCount = await db.clinicalNote.count({
    where: { visit: { patientId }, status: { not: "SIGNED" } },
  });
  const openClaimCount = await db.claim.count({
    where: { patientId, status: { in: ["SUBMITTED", "ACCEPTED", "REJECTED"] } },
  });
  const openBalance = await db.claim.aggregate({
    where: { patientId, status: { notIn: ["VOIDED", "PAID"] } },
    _sum: { balanceAmount: true },
  });

  return {
    patient: domain,
    counts: {
      visitCount,
      completedCount,
      upcomingCount,
      openOrderCount,
      unsignedNoteCount,
      openClaimCount,
    },
    openBalance: Number(openBalance._sum.balanceAmount ?? 0),
  };
}
