import type { FastifyInstance } from "fastify";
import type { ClaimStatus } from "@prisma/client";
import { contextFor } from "../request-context.js";
import { createCharge, createPostedChargeWithSnapshot, postCharge } from "../../revenue-cycle/charge-service.js";
import { buildClaimsForOrganization } from "../../revenue-cycle/claim-builder.js";
import { createClaimForCharges, previewCorrectedClaim, submitClaim, claimQueue } from "../../revenue-cycle/claim-service.js";
import { rejectionWorklist, resolveRejection, ingestRejection } from "../../revenue-cycle/rejection-service.js";
import { createCorrectedClaim, resubmitCorrectedClaim } from "../../revenue-cycle/correction-service.js";
import { generateStatement, generateStatementBatch, listStatements } from "../../revenue-cycle/statement-service.js";
import { comparePricingPaths } from "../../pricing/price-compare.js";
import { previewOrderValue } from "../../orders/order-price-preview.js";

function toDate(value: unknown): Date {
  return new Date(String(value));
}

export async function registerRevenueRoutes(app: FastifyInstance): Promise<void> {
  app.post("/visits/:id/charges", async (request) => createCharge((request.params as { id: string }).id));
  app.post("/visits/:id/charges/posted", async (request) => createPostedChargeWithSnapshot((request.params as { id: string }).id));
  app.post("/charges/:id/post", async (request) => postCharge((request.params as { id: string }).id));

  app.post("/claims/build", async (request) => buildClaimsForOrganization(await contextFor(request), request.body as { limit?: number }));
  app.post("/claims", async (request) => {
    const input = request.body as { organizationId: string; patientId: string; payerId: string; chargeIds: string[] };
    return createClaimForCharges(input.organizationId, input.patientId, input.payerId, input.chargeIds);
  });
  app.get("/claims", async (request) => {
    const context = await contextFor(request);
    const query = request.query as { status?: string; payerId?: string; patientId?: string; minBalance?: string; page?: string; pageSize?: string };
    return claimQueue(
      context.organizationId,
      { status: query.status as ClaimStatus | undefined, payerId: query.payerId, patientId: query.patientId, minBalance: query.minBalance ? Number(query.minBalance) : undefined },
      Number(query.page ?? 1),
      Number(query.pageSize ?? 25),
    );
  });
  app.get("/claims/:id/reprice", async (request) => previewCorrectedClaim((request.params as { id: string }).id));
  app.post("/claims/:id/submit", async (request) => {
    const input = (request.body ?? {}) as { simulateTimeout?: boolean };
    return submitClaim((request.params as { id: string }).id, input.simulateTimeout);
  });
  app.post("/claims/:id/correct", async (request) => {
    const input = (request.body ?? {}) as { voidOriginal?: boolean };
    return createCorrectedClaim(await contextFor(request), (request.params as { id: string }).id, { voidOriginal: input.voidOriginal });
  });
  app.post("/claims/:id/resubmit", async (request) => resubmitCorrectedClaim(await contextFor(request), (request.params as { id: string }).id));

  app.get("/rejections", async (request) => rejectionWorklist(await contextFor(request)));
  app.post("/rejections/ingest", async (request) => {
    const input = request.body as { claimExternalId: string; code: string; message: string; category?: string };
    return ingestRejection(input.claimExternalId, input.code, input.message, input.category);
  });
  app.post("/rejections/:id/resolve", async (request) => {
    const input = request.body as { resolution: string };
    return resolveRejection(await contextFor(request), (request.params as { id: string }).id, input.resolution);
  });

  app.post("/statements", async (request) => {
    const input = request.body as { patientId: string; start: string; end: string };
    return generateStatement(input.patientId, toDate(input.start), toDate(input.end));
  });
  app.post("/statements/batch", async (request) => {
    const context = await contextFor(request);
    const input = request.body as { start: string; end: string };
    return generateStatementBatch(context.organizationId, toDate(input.start), toDate(input.end), context.userId);
  });
  app.get("/statements", async (request) => {
    const context = await contextFor(request);
    return listStatements(context.organizationId);
  });

  app.get("/orders/:id/value", async (request) => previewOrderValue((request.params as { id: string }).id));
  app.get("/pricing/compare/:visitId", async (request) => comparePricingPaths((request.params as { visitId: string }).visitId));
}
