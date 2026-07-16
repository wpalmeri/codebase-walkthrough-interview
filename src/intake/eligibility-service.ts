import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";

/**
 * Eligibility verification. The payer "API" is the local simulator; responses
 * are deterministic on member id so seed data stays stable. The check runs
 * inline in the intake request and its full payload is stored per check.
 */

interface EligibilityResponse {
  eligible: boolean;
  planActive: boolean;
  copay: number | null;
  coinsurancePercent: number | null;
  deductibleRemaining: number | null;
  payerMessage: string;
}

export function simulateEligibilityResponse(memberId: string): EligibilityResponse {
  const digits = memberId.replace(/\D/g, "");
  const seedValue = Number(digits.slice(-2) || "0");
  const eligible = seedValue % 9 !== 7;
  return {
    eligible,
    planActive: eligible,
    copay: eligible ? [0, 20, 35][seedValue % 3]! : null,
    coinsurancePercent: eligible ? [0, 10, 20][seedValue % 3]! : null,
    deductibleRemaining: eligible ? (seedValue % 4) * 250 : null,
    payerMessage: eligible ? "Coverage active" : "Member not found for date of service",
  };
}

export async function runEligibilityCheck(context: RequestContext, coverageId: string) {
  const coverage = await db.insuranceCoverage.findUnique({ where: { id: coverageId }, include: { patient: true } });
  if (!coverage || coverage.patient.organizationId !== context.organizationId) {
    throw new NotFoundError("Coverage not found");
  }
  const response = simulateEligibilityResponse(coverage.memberId);
  const check = await db.eligibilityCheck.create({
    data: {
      coverageId,
      requestedBy: context.userId,
      eligible: response.eligible,
      source: "REALTIME",
      response: asJson(response),
    },
  });
  if (response.eligible) {
    await db.insuranceCoverage.update({ where: { id: coverageId }, data: { verifiedAt: new Date() } });
  }
  return { check, response };
}
