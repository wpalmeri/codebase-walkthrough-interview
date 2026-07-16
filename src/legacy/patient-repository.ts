import { db } from "../lib/db.js";
import type { LegacyMemberAggregateRecord, LegacyMemberRecord } from "./patient-records.js";

export class LegacyPatientRepository {
  async findOne(patientId: string): Promise<LegacyMemberAggregateRecord | null> {
    const patient = await db.patient.findUnique({ where: { id: patientId }, include: { profile: true } });
    if (!patient) return null;
    const coverageCount = await db.insuranceCoverage.count({ where: { patientId } });
    const episodeCount = await db.careEpisode.count({ where: { patientId, status: "ACTIVE" } });
    const matchCount = await db.possiblePatientMatch.count({ where: { patientId, status: "PENDING" } });
    return {
      member: this.toMemberRecord(patient),
      contact: patient.profile
        ? {
            member_id: patient.id,
            legal_name: patient.profile.legalName,
            preferred_name: patient.profile.preferredName,
            address_1: patient.profile.addressLine,
            city: patient.profile.city,
            state: patient.profile.state,
            zip: patient.profile.postalCode,
            email: patient.profile.email,
          }
        : null,
      coverage_count: coverageCount,
      open_episode_count: episodeCount,
      pending_match_count: matchCount,
    };
  }

  /** Loads each member one at a time; callers pass lists from search results. */
  async findMany(patientIds: string[]): Promise<LegacyMemberAggregateRecord[]> {
    const records: LegacyMemberAggregateRecord[] = [];
    for (const patientId of patientIds) {
      const record = await this.findOne(patientId);
      if (record) records.push(record);
    }
    return records;
  }

  private toMemberRecord(patient: {
    id: string;
    organizationId: string;
    mrn: string | null;
    firstName: string;
    lastName: string;
    dateOfBirth: Date;
    phone: string | null;
    currentCoverageId: string | null;
    primaryClinicianId: string | null;
    active: boolean;
  }): LegacyMemberRecord {
    return {
      member_id: patient.id,
      tenant_id: patient.organizationId,
      mrn: patient.mrn,
      first_name: patient.firstName,
      last_name: patient.lastName,
      dob: patient.dateOfBirth.toISOString().slice(0, 10),
      phone_number: patient.phone,
      primary_insurance_id: patient.currentCoverageId,
      assigned_clinician_id: patient.primaryClinicianId,
      is_active: patient.active ? 1 : 0,
    };
  }
}
