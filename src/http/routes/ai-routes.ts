import type { FastifyInstance } from "fastify";
import { contextFor } from "../request-context.js";
import { investigateBillingBlockers, askOperations, executeProposedAction, listAiRuns, getAiRun } from "../../ai-employee/operations-agent.js";
import { explainVisitPrice } from "../../ai-employee/price-explanation.js";
import { aiQualitySnapshot } from "../../ai-employee/evaluation.js";
import { AI_TOOLS } from "../../ai-employee/tools.js";

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ai/tools", async () => AI_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, mutates: tool.mutates })));

  app.post("/ai/billing-blockers", async (request) => {
    const input = request.body as { organizationId: string; requestedBy: string };
    return investigateBillingBlockers(input.organizationId, input.requestedBy);
  });
  app.post("/ai/ask", async (request) => {
    const context = await contextFor(request);
    const input = request.body as { question: string };
    return askOperations(context.organizationId, context.userId, input.question);
  });
  app.get("/ai/runs", async (request) => {
    const context = await contextFor(request);
    return listAiRuns(context.organizationId);
  });
  app.get("/ai/runs/:id", async (request) => getAiRun((request.params as { id: string }).id));
  app.post("/ai/actions/:id/execute", async (request) => {
    const context = await contextFor(request);
    return executeProposedAction((request.params as { id: string }).id, context.userId);
  });
  app.get("/ai/visits/:id/price-explanation", async (request) => explainVisitPrice((request.params as { id: string }).id));
  app.get("/ai/quality", async (request) => {
    const context = await contextFor(request);
    return aiQualitySnapshot(context.organizationId);
  });
}
