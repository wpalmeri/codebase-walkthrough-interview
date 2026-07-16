// Billing record shapes shared with the original clearinghouse integration.
// The external vendor spec (docs/integration-contracts/clearinghouse.md)
// still references these field names.

export interface LegacyChargeRecord {
  charge_id: string;
  encounter_id: string; // visit id
  insurance_id: string | null;
  charge_status: string;
  total_amount: string; // decimal string
  posted_date: string | null;
}

export interface LegacyChargeLineRecord {
  line_id: string;
  charge_id: string;
  procedure_code: string;
  modifier_1: string | null;
  unit_count: string;
  unit_price: string;
  line_amount: string;
}

export interface LegacyClaimRecord {
  claim_id: string;
  tenant_id: string;
  member_id: string;
  payer_code: string;
  claim_status: string;
  clearinghouse_ref: string | null;
  total_billed: string;
  open_balance: string;
  submitted_date: string | null;
}

export interface LegacyClaimAggregateRecord {
  claim: LegacyClaimRecord;
  charges: LegacyChargeRecord[];
  lines: LegacyChargeLineRecord[];
  rejection_codes: string[];
}
