// Legacy patient record shapes preserved from the pre-pivot "member" module.
// Downstream mappers and two integrations still consume these snake_case
// structures.

export interface LegacyMemberRecord {
  member_id: string;
  tenant_id: string;
  mrn: string | null;
  first_name: string;
  last_name: string;
  dob: string;
  phone_number: string | null;
  primary_insurance_id: string | null;
  assigned_clinician_id: string | null;
  is_active: 0 | 1;
}

export interface LegacyMemberContactRecord {
  member_id: string;
  legal_name: string;
  preferred_name: string | null;
  address_1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  email: string | null;
}

export interface LegacyMemberAggregateRecord {
  member: LegacyMemberRecord;
  contact: LegacyMemberContactRecord | null;
  coverage_count: number;
  open_episode_count: number;
  pending_match_count: number;
}
