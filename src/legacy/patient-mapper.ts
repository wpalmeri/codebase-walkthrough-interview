import type { LegacyMemberAggregateRecord } from "./patient-records.js";
import type { PatientDomainModel } from "../domain/patient.js";

export function legacyMemberToDomain(record: LegacyMemberAggregateRecord): PatientDomainModel {
  return {
    id: record.member.member_id,
    organizationId: record.member.tenant_id,
    mrn: record.member.mrn,
    displayName: record.contact?.preferred_name ?? `${record.member.first_name} ${record.member.last_name}`,
    legalName: record.contact?.legal_name ?? null,
    dateOfBirth: new Date(record.member.dob),
    phone: record.member.phone_number,
    primaryClinicianId: record.member.assigned_clinician_id,
    currentCoverageId: record.member.primary_insurance_id,
    active: record.member.is_active === 1,
    flags: {
      hasUnverifiedCoverage: record.coverage_count === 0,
      hasPossibleDuplicates: record.pending_match_count > 0,
      missingDemographics: record.contact === null,
    },
  };
}
