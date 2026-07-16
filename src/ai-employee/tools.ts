import { db } from "../lib/db.js";
import { authorizationSummary } from "../orders/authorization-service.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("ai-tools");

/**
 * Tool implementations the AI employee can call.
 *
 * Every tool runs with a broad service identity and reads ORM tables
 * directly, returning whole rows (including patient PHI and full note
 * content) into the model context. There is no per-tool scoping to the
 * requesting user's branches, and read tools and the one write tool
 * (resubmit_claim) sit in the same registry with only a naming convention to
 * separate them.
 */

export interface AiToolContext {
  organizationId: string;
  runId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  mutates: boolean;
  run: (args: Record<string, unknown>, context: AiToolContext) => Promise<unknown>;
}

async function record(context: AiToolContext, toolName: string, args: Record<string, unknown>, result: unknown, error?: string) {
  await db.aiToolInvocation.create({
    data: { runId: context.runId, toolName, arguments: args as object, result: error ? undefined : (result as object), error, completedAt: new Date() },
  });
}

export const AI_TOOLS: ToolDefinition[] = [
  {
    name: "list_unsigned_visits",
    description: "List completed visits whose notes are not signed.",
    mutates: false,
    run: async (args, context) => {
      const hoursOld = Number(args.hoursOld ?? 0);
      const cutoff = new Date(Date.now() - hoursOld * 3_600_000);
      const visits = await db.visit.findMany({
        where: {
          status: "COMPLETED",
          completedAt: { lte: cutoff },
          visitGroup: { visitSet: { organizationId: context.organizationId } },
          notes: { none: { status: "SIGNED" } },
        },
        include: { patient: { include: { profile: true, demographics: true } }, notes: true, visitGroup: { include: { branch: true } } },
        take: 25,
      });
      return visits.map((visit) => ({
        visitId: visit.id,
        patient: `${visit.patient.firstName} ${visit.patient.lastName}`,
        dateOfBirth: visit.patient.dateOfBirth,
        branch: visit.visitGroup.branch.name,
        completedAt: visit.completedAt,
        noteContent: visit.notes[0]?.content ?? null,
      }));
    },
  },
  {
    name: "list_rejected_claims",
    description: "List claims currently in REJECTED status with rejection reasons.",
    mutates: false,
    run: async (args, context) => {
      const claims = await db.claim.findMany({
        where: { organizationId: context.organizationId, status: "REJECTED" },
        include: { rejections: true, patient: true, lines: true },
        take: Number(args.limit ?? 10),
      });
      return claims.map((claim) => ({
        claimId: claim.id,
        patient: `${claim.patient.firstName} ${claim.patient.lastName}`,
        total: Number(claim.totalAmount),
        rejections: claim.rejections.map((rejection) => ({ code: rejection.code, message: rejection.message })),
      }));
    },
  },
  {
    name: "get_claim_detail",
    description: "Get full detail for a single claim including charge provenance.",
    mutates: false,
    run: async (args, context) => {
      const claimId = String(args.claimId);
      const claim = await db.claim.findFirst({
        where: { id: claimId, organizationId: context.organizationId },
        include: { lines: { include: { chargeLine: { include: { charge: true } } } }, rejections: true, patient: { include: { coverages: true } } },
      });
      return claim;
    },
  },
  {
    name: "get_authorization_status",
    description: "Return authorization utilization for a visit set.",
    mutates: false,
    run: async (args) => authorizationSummary(String(args.visitSetId)),
  },
  {
    name: "explain_visit_price",
    description: "Explain the expected price of a visit under current coverage.",
    mutates: false,
    run: async (args, context) => {
      const visit = await db.visit.findFirst({
        where: { id: String(args.visitId), visitGroup: { visitSet: { organizationId: context.organizationId } } },
        include: { patient: { include: { coverages: true } }, visitGroup: { include: { visitSet: true } } },
      });
      if (!visit) return { error: "visit not found" };
      const coverage = visit.patient.coverages.find((item) => item.id === visit.patient.currentCoverageId) ?? visit.patient.coverages[0];
      const rate = await db.payerRate.findFirst({
        where: { serviceType: visit.visitGroup.visitSet.serviceType, contract: { payerId: coverage?.payerId } },
      });
      return { visitId: visit.id, expectedPrice: Number(rate?.amount ?? 100), coverage: coverage?.planName ?? "unknown" };
    },
  },
  {
    name: "resubmit_claim",
    description: "Resubmit a claim to the clearinghouse. MUTATES external state.",
    mutates: true,
    run: async (args, context) => {
      // Imported lazily to avoid a cycle with the revenue-cycle module.
      const { submitClaim } = await import("../revenue-cycle/claim-service.js");
      const claim = await db.claim.findFirst({ where: { id: String(args.claimId), organizationId: context.organizationId } });
      if (!claim) return { error: "claim not found" };
      return submitClaim(claim.id);
    },
  },
];

export async function invokeTool(name: string, args: Record<string, unknown>, context: AiToolContext): Promise<unknown> {
  const tool = AI_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    log.warn({ name }, "model requested unknown tool");
    return { error: `unknown tool ${name}` };
  }
  try {
    const result = await tool.run(args, context);
    await record(context, name, args, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await record(context, name, args, null, message);
    return { error: message };
  }
}

export function toolNames(): string[] {
  return AI_TOOLS.map((tool) => tool.name);
}
