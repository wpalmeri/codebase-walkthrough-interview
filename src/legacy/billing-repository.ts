import { db } from "../lib/db.js";
import type {
  LegacyChargeLineRecord,
  LegacyChargeRecord,
  LegacyClaimAggregateRecord,
} from "./billing-records.js";

export class LegacyBillingRepository {
  async findClaim(claimId: string): Promise<LegacyClaimAggregateRecord | null> {
    const claim = await db.claim.findUnique({
      where: { id: claimId },
      include: { lines: { include: { chargeLine: { include: { charge: true } } } }, rejections: true },
    });
    if (!claim) return null;
    const payer = await db.payer.findUnique({ where: { id: claim.payerId } });

    const chargeRecords = new Map<string, LegacyChargeRecord>();
    const lineRecords: LegacyChargeLineRecord[] = [];
    for (const line of claim.lines) {
      const charge = line.chargeLine.charge;
      chargeRecords.set(charge.id, {
        charge_id: charge.id,
        encounter_id: charge.visitId,
        insurance_id: charge.coverageId,
        charge_status: charge.status,
        total_amount: charge.totalAmount?.toString() ?? "0",
        posted_date: charge.postedAt?.toISOString() ?? null,
      });
      lineRecords.push({
        line_id: line.chargeLine.id,
        charge_id: charge.id,
        procedure_code: line.chargeLine.serviceCode,
        modifier_1: line.chargeLine.modifier,
        unit_count: line.chargeLine.units.toString(),
        unit_price: line.chargeLine.unitPrice.toString(),
        line_amount: line.chargeLine.amount.toString(),
      });
    }

    return {
      claim: {
        claim_id: claim.id,
        tenant_id: claim.organizationId,
        member_id: claim.patientId,
        payer_code: payer?.code ?? "UNKNOWN",
        claim_status: claim.status,
        clearinghouse_ref: claim.externalId,
        total_billed: claim.totalAmount.toString(),
        open_balance: claim.balanceAmount.toString(),
        submitted_date: claim.submittedAt?.toISOString() ?? null,
      },
      charges: [...chargeRecords.values()],
      lines: lineRecords,
      rejection_codes: claim.rejections.map((rejection) => rejection.code),
    };
  }
}
