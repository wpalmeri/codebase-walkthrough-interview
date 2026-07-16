import { db } from "../../src/lib/db.js";
import { loadContext } from "../../src/permissions/context-loader.js";
import { findDuplicateCandidates } from "../../src/intake/duplicate-detection.js";
import { createPatient } from "../../src/intake/patient-service.js";
import { simulateEligibilityResponse } from "../../src/intake/eligibility-service.js";

describe("intake and patient identity", () => {
  it("detects an exact name + date-of-birth duplicate", async () => {
    const context = await loadContext("user_admin");
    const existing = await db.patient.findUniqueOrThrow({ where: { id: "patient_000" } });
    const candidates = await findDuplicateCandidates(context, {
      firstName: existing.firstName,
      lastName: existing.lastName,
      dateOfBirth: existing.dateOfBirth,
    });
    expect(candidates.some((candidate) => candidate.patientId === "patient_000")).toBe(true);
  });

  it("creates a patient even when a duplicate exists, deferring to human review", async () => {
    const context = await loadContext("user_admin");
    const existing = await db.patient.findUniqueOrThrow({ where: { id: "patient_000" } });
    const { patient, possibleMatches } = await createPatient(context, {
      firstName: existing.firstName,
      lastName: existing.lastName,
      dateOfBirth: existing.dateOfBirth,
    });
    expect(possibleMatches.length).toBeGreaterThan(0);
    // The new record was created regardless; there is no blocking uniqueness constraint.
    const created = await db.patient.findUnique({ where: { id: patient.id } });
    expect(created).not.toBeNull();

    await db.possiblePatientMatch.deleteMany({ where: { patientId: patient.id } });
    await db.auditEvent.deleteMany({ where: { resourceId: patient.id } });
    await db.domainEvent.deleteMany({ where: { aggregateId: patient.id } });
    await db.analyticsEvent.deleteMany({ where: { properties: { path: ["patientId"], equals: patient.id } } });
    await db.patientDemographics.deleteMany({ where: { patientId: patient.id } });
    await db.patientProfile.deleteMany({ where: { patientId: patient.id } });
    await db.patient.delete({ where: { id: patient.id } });
  });

  it("can skip duplicate matching entirely on the urgent-admit path", async () => {
    const context = await loadContext("user_admin");
    const existing = await db.patient.findUniqueOrThrow({ where: { id: "patient_000" } });
    const { possibleMatches, patient } = await createPatient(context, {
      firstName: existing.firstName, lastName: existing.lastName, dateOfBirth: existing.dateOfBirth,
    }, true);
    expect(possibleMatches).toHaveLength(0);

    await db.auditEvent.deleteMany({ where: { resourceId: patient.id } });
    await db.domainEvent.deleteMany({ where: { aggregateId: patient.id } });
    await db.patientDemographics.deleteMany({ where: { patientId: patient.id } });
    await db.patientProfile.deleteMany({ where: { patientId: patient.id } });
    await db.patient.delete({ where: { id: patient.id } });
  });

  it("returns deterministic eligibility so seeds and tests stay stable", () => {
    const first = simulateEligibilityResponse("M100001");
    const second = simulateEligibilityResponse("M100001");
    expect(first).toEqual(second);
  });
});
