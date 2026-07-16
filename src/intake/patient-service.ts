import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { writeAudit } from "../audit/audit-service.js";
import { track } from "../events/analytics.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_PATIENT_CREATED } from "../events/event-names.js";
import { findDuplicateCandidates, recordPossibleMatches } from "./duplicate-detection.js";

export interface NewPatientInput {
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  phone?: string;
  email?: string;
  mrn?: string;
  preferredName?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  language?: string;
  gender?: string;
}

export async function findPossiblePatients(context: RequestContext, input: NewPatientInput) {
  return db.patient.findMany({
    where: {
      organizationId: context.organizationId,
      dateOfBirth: input.dateOfBirth,
      OR: [
        { firstName: { equals: input.firstName, mode: "insensitive" }, lastName: { equals: input.lastName, mode: "insensitive" } },
        { profile: { preferredName: { equals: input.firstName, mode: "insensitive" } } },
      ],
    },
    include: { profile: true, demographics: true },
  });
}

/**
 * Creates a patient. Callers can pass skipMatching to bypass duplicate
 * detection entirely — the "urgent admit" path in the intake modal and both
 * external integrations set it. When matching does run, the patient is
 * created regardless and any candidates become PossiblePatientMatch rows for
 * later review; there is no blocking merge step.
 */
export async function createPatient(context: RequestContext, input: NewPatientInput, skipMatching = false) {
  const candidates = skipMatching ? [] : await findDuplicateCandidates(context, input);

  const patient = await db.patient.create({
    data: {
      organizationId: context.organizationId,
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: input.dateOfBirth,
      phone: input.phone,
      mrn: input.mrn,
      profile: {
        create: {
          legalName: `${input.firstName} ${input.lastName}`,
          preferredName: input.preferredName,
          phone: input.phone,
          email: input.email,
          addressLine: input.addressLine,
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
        },
      },
      demographics: {
        create: {
          givenName: input.firstName,
          familyName: input.lastName,
          birthDate: input.dateOfBirth,
          language: input.language,
          gender: input.gender,
        },
      },
    },
  });

  if (candidates.length > 0) await recordPossibleMatches(patient.id, candidates);
  await writeAudit(context.organizationId, context.userId, "patient.created", "Patient", patient.id, {
    skippedMatching: skipMatching,
    possibleDuplicates: candidates.length,
  });
  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_PATIENT_CREATED,
    aggregateType: "Patient",
    aggregateId: patient.id,
    payload: { patientId: patient.id, lastName: patient.lastName },
    emittedBy: context.userId,
  });
  track("patientCreated", { patientId: patient.id }, context);

  return { patient, possibleMatches: candidates };
}

/**
 * Demographics live in three places (Patient, PatientProfile,
 * PatientDemographics). Updates write all three; older import tooling only
 * writes Patient, which is how the copies drift.
 */
export async function updateDemographics(
  context: RequestContext,
  patientId: string,
  updates: Partial<Pick<NewPatientInput, "firstName" | "lastName" | "phone" | "email" | "language" | "gender" | "preferredName">>,
) {
  const patient = await db.patient.findFirstOrThrow({ where: { id: patientId, organizationId: context.organizationId } });
  const updated = await db.patient.update({
    where: { id: patient.id },
    data: { firstName: updates.firstName, lastName: updates.lastName, phone: updates.phone },
  });
  await db.patientProfile.update({
    where: { patientId: patient.id },
    data: {
      preferredName: updates.preferredName,
      phone: updates.phone,
      email: updates.email,
      legalName: updates.firstName && updates.lastName ? `${updates.firstName} ${updates.lastName}` : undefined,
    },
  });
  await db.patientDemographics.update({
    where: { patientId: patient.id },
    data: { givenName: updates.firstName, familyName: updates.lastName, language: updates.language, gender: updates.gender },
  });
  await writeAudit(context.organizationId, context.userId, "patient.updated", "Patient", patient.id, updates);
  return updated;
}
