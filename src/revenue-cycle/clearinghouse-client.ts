import { env } from "../config/env.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("clearinghouse");

export interface ClearinghouseSubmission {
  claimId: string;
  payerCode: string;
  totalAmount: string;
  lines: Array<{ procedureCode: string; units: string; amount: string }>;
}

export interface ClearinghouseAck {
  accepted: boolean;
  externalId: string;
  requestId: string;
}

/**
 * HTTP client for the claim clearinghouse. Submissions carry no idempotency
 * key; the vendor assigns an external id per POST. A network timeout after
 * the vendor accepted (INC-1088) leaves us with no record of the external id
 * — retrying creates a second, duplicate claim on the payer side.
 */
export async function submitToClearinghouse(
  submission: ClearinghouseSubmission,
  options?: { timeoutMs?: number; simulateTimeout?: boolean },
): Promise<ClearinghouseAck> {
  const requestId = `REQ-${submission.claimId}-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10_000);

  try {
    const response = await fetch(env().clearinghouseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...submission, requestId, simulateTimeout: options?.simulateTimeout ?? false }),
      signal: controller.signal,
    });
    const body = (await response.json()) as { accepted: boolean; externalId: string };
    if (!response.ok || !body.accepted) {
      throw new Error(`Clearinghouse rejected submission for claim ${submission.claimId}`);
    }
    return { accepted: true, externalId: body.externalId, requestId };
  } catch (error) {
    log.error({ claimId: submission.claimId, requestId, error: error instanceof Error ? error.message : String(error) }, "clearinghouse submission failed");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
