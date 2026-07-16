import { ingestRejection } from "../revenue-cycle/rejection-service.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("clearinghouse-sim");

/**
 * Deterministic clearinghouse simulator. Accepts a submission and, for a
 * fraction of claims, schedules a rejection callback. Rejection reasons are
 * keyed off the request id so seed and tests stay stable.
 */

const REJECTION_REASONS = [
  { code: "CO-16", message: "Claim lacks information needed for adjudication", category: "MISSING_INFO" },
  { code: "CO-97", message: "Payment adjusted; service included in another service", category: "BUNDLING" },
  { code: "PR-1", message: "Deductible amount", category: "PATIENT_RESPONSIBILITY" },
  { code: "CO-29", message: "Time limit for filing has expired", category: "TIMELY_FILING" },
  { code: "CO-11", message: "Diagnosis inconsistent with procedure", category: "CODING" },
];

export interface SubmissionRequest {
  claimId: string;
  payerCode: string;
  totalAmount: string;
  requestId?: string;
  simulateTimeout?: boolean;
}

export function handleSubmission(request: SubmissionRequest) {
  if (request.simulateTimeout) {
    // The vendor accepts and assigns an external id, then the connection is
    // dropped before the caller sees this response.
    return { accepted: true, externalId: `CH-ACCEPTED-${request.requestId ?? Date.now()}`, note: "connection dropped after accept" };
  }
  const externalId = `CH-${request.claimId}-${Math.abs(hash(request.requestId ?? request.claimId)) % 100000}`;
  return { accepted: true, externalId };
}

/** Called by the callback endpoint to push a rejection for a submitted claim. */
export async function simulateRejectionCallback(claimExternalId: string, seed?: number) {
  const reason = REJECTION_REASONS[(seed ?? Math.abs(hash(claimExternalId))) % REJECTION_REASONS.length]!;
  log.info({ claimExternalId, code: reason.code }, "simulated rejection callback");
  return ingestRejection(claimExternalId, reason.code, reason.message, reason.category);
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return result;
}
