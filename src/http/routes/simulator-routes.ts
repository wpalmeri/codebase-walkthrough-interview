import type { FastifyInstance } from "fastify";
import { handleSubmission, simulateRejectionCallback, type SubmissionRequest } from "../../integrations/clearinghouse-simulator.js";
import { moduleLogger } from "../../lib/logger.js";

const log = moduleLogger("simulators");

/**
 * Local stand-ins for the external clearinghouse, CRM, and generic webhook
 * receiver. They run inside the same process so the exercise needs no cloud
 * credentials.
 */
export async function registerSimulatorRoutes(app: FastifyInstance): Promise<void> {
  app.post("/simulators/clearinghouse", async (request) => {
    const body = request.body as SubmissionRequest;
    return handleSubmission(body);
  });
  app.post("/simulators/clearinghouse/reject", async (request) => {
    const body = request.body as { claimExternalId: string; seed?: number };
    return simulateRejectionCallback(body.claimExternalId, body.seed);
  });
  app.post("/simulators/crm", async (request) => {
    log.debug({ body: request.body }, "crm simulator received");
    return { delivered: true, received: request.body };
  });
  app.post("/simulators/webhook", async (request) => {
    log.debug({ headers: request.headers["x-signature"], body: request.body }, "webhook simulator received");
    return { ok: true };
  });
}
