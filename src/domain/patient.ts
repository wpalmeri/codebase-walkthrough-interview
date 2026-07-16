export interface PatientDomainModel {
  id: string;
  organizationId: string;
  mrn: string | null;
  displayName: string;
  legalName: string | null;
  dateOfBirth: Date;
  phone: string | null;
  primaryClinicianId: string | null;
  currentCoverageId: string | null;
  active: boolean;
  flags: PatientFlags;
}

export interface PatientFlags {
  hasUnverifiedCoverage: boolean;
  hasPossibleDuplicates: boolean;
  missingDemographics: boolean;
}

export function patientAgeYears(patient: PatientDomainModel, asOf: Date = new Date()): number {
  const diff = asOf.getTime() - patient.dateOfBirth.getTime();
  return Math.floor(diff / (365.25 * 86_400_000));
}

export function patientInitials(patient: PatientDomainModel): string {
  return patient.displayName
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
