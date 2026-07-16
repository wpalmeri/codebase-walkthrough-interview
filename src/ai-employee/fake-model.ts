import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("fake-model");

/**
 * Deterministic fake model provider. No API key, no network. Given a prompt
 * and the available tool names, it returns a canned plan: a natural-language
 * answer plus zero or more tool calls and (optionally) a proposed action.
 *
 * The determinism is keyed off substrings in the prompt so seeds and tests
 * are stable. This stands in for a real LLM adapter; the surrounding agent
 * code treats its output as trusted, which is the point of the exercise.
 */

export interface ModelToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ProposedAction {
  type: string;
  arguments: Record<string, unknown>;
  summary: string;
}

export interface ModelResponse {
  answer: string;
  toolCalls: ModelToolCall[];
  proposedAction?: ProposedAction;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelRequest {
  prompt: string;
  availableTools: string[];
  organizationId: string;
}

export async function runFakeModel(request: ModelRequest): Promise<ModelResponse> {
  // Intent is derived from the question line only; the serialized context
  // below it always mentions "rejectedClaims"/"unsignedVisits" in the summary,
  // which would otherwise match every branch.
  const questionLine = request.prompt.split("\n")[0] ?? request.prompt;
  const prompt = questionLine.toLowerCase();
  const usage = { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: 120 };
  log.debug({ tools: request.availableTools.length, inputTokens: usage.inputTokens }, "fake-model invoked");

  if (prompt.includes("cannot be billed") || prompt.includes("billing blocker") || prompt.includes("billing-blocker")) {
    return {
      answer:
        "Several completed visits are missing signed documentation, and one authorization is fully consumed. Those are the main billing blockers; I have listed the affected visits with the specific reason for each.",
      toolCalls: [
        { tool: "list_unsigned_visits", arguments: { hoursOld: 0 } },
        { tool: "get_authorization_status", arguments: { visitSetId: "from-context" } },
      ],
      usage,
    };
  }

  if (prompt.includes("rejected") || prompt.includes("rejection")) {
    return {
      answer:
        "Three claims were rejected for missing information (CO-16). The most common cause is an absent authorization number on the claim line. I can prepare corrected claims and resubmit them once you approve.",
      toolCalls: [
        { tool: "list_rejected_claims", arguments: { limit: 10 } },
        { tool: "get_claim_detail", arguments: { claimId: "from-context" } },
      ],
      proposedAction: {
        type: "RESUBMIT_CLAIM",
        arguments: { claimId: "from-context" },
        summary: "Correct and resubmit the oldest CO-16 rejected claim",
      },
      usage,
    };
  }

  if (prompt.includes("unsigned") || prompt.includes("documentation")) {
    return {
      answer:
        "There are completed visits without signed documentation, some more than four hours old. I can assign follow-up tasks to the supervising clinicians.",
      toolCalls: [{ tool: "list_unsigned_visits", arguments: { hoursOld: 4 } }],
      proposedAction: {
        type: "ASSIGN_TASK",
        arguments: { queue: "clinical-supervisors", reason: "unsigned-documentation" },
        summary: "Assign documentation follow-up tasks to supervising clinicians",
      },
      usage,
    };
  }

  if (prompt.includes("revenue") || prompt.includes("expected revenue")) {
    return {
      answer:
        "Expected revenue changed because two payer rates were updated this month and one patient's coverage was corrected retroactively. The largest single driver is the skilled-nursing rate increase in the San Francisco branch.",
      toolCalls: [{ tool: "explain_visit_price", arguments: { visitId: "from-context" } }],
      usage,
    };
  }

  return {
    answer: "I reviewed the available operational records. Ask me about rejected claims, unsigned documentation, billing blockers, or revenue changes.",
    toolCalls: [],
    usage,
  };
}
