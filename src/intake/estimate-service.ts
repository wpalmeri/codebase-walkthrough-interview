import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";

/**
 * Estimated patient responsibility shown during intake.
 *
 * Resolves the payer rate as of *today* against the patient's *current*
 * coverage, then layers plan cost-sharing on top with float math. The result
 * is stored nowhere, so the number a family was quoted cannot be reproduced
 * once rates or coverage change.
 */

export interface ResponsibilityEstimate {
  serviceType: string;
  visits: number;
  contractRate: number;
  grossAmount: number;
  copayPortion: number;
  coinsurancePortion: number;
  estimatedResponsibility: number;
  disclaimer: string;
}

export async function estimatePatientResponsibility(
  context: RequestContext,
  patientId: string,
  serviceType: string,
  visits: number,
): Promise<ResponsibilityEstimate> {
  const patient = await db.patient.findFirst({ where: { id: patientId, organizationId: context.organizationId } });
  if (!patient?.currentCoverageId) throw new NotFoundError("Patient has no active coverage");
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: patient.currentCoverageId } });

  const rate = await db.payerRate.findFirst({
    where: {
      serviceType,
      contract: { payerId: coverage.payerId, organizationId: context.organizationId, active: true },
    },
  });
  const contractRate = rate ? Number(rate.amount) : 100;

  const copay = coverage.copayAmount ? Number(coverage.copayAmount) : 0;
  const coinsurance = coverage.coinsurancePercent ?? 20;
  const grossAmount = contractRate * visits;
  const copayPortion = copay * visits;
  const coinsurancePortion = (grossAmount - copayPortion) * (coinsurance / 100);

  return {
    serviceType,
    visits,
    contractRate,
    grossAmount,
    copayPortion,
    coinsurancePortion,
    estimatedResponsibility: copayPortion + coinsurancePortion,
    disclaimer: "Estimate based on current plan benefits; actual responsibility may differ.",
  };
}
