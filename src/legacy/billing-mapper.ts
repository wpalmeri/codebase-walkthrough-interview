import type { LegacyClaimAggregateRecord } from "./billing-records.js";

export interface ClaimApiDto {
  id: string;
  patientId: string;
  payerCode: string;
  status: string;
  clearinghouseReference: string | null;
  totalBilled: number;
  openBalance: number;
  submittedAt: string | null;
  lineCount: number;
  rejectionCodes: string[];
}

export function legacyClaimToApiDto(record: LegacyClaimAggregateRecord): ClaimApiDto {
  return {
    id: record.claim.claim_id,
    patientId: record.claim.member_id,
    payerCode: record.claim.payer_code,
    status: record.claim.claim_status,
    clearinghouseReference: record.claim.clearinghouse_ref,
    totalBilled: Number(record.claim.total_billed),
    openBalance: Number(record.claim.open_balance),
    submittedAt: record.claim.submitted_date,
    lineCount: record.lines.length,
    rejectionCodes: record.rejection_codes,
  };
}
