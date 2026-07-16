import type { FastifyInstance } from "fastify";
import { contextFor } from "../request-context.js";
import { createPatient, updateDemographics } from "../../intake/patient-service.js";
import { createIntakeOrder, abandonIntake } from "../../intake/intake-service.js";
import { findDuplicateCandidates, pendingMatchQueue, resolveMatch } from "../../intake/duplicate-detection.js";
import { addCoverage, coverageHistory, replaceCoverage } from "../../intake/coverage-service.js";
import { runEligibilityCheck } from "../../intake/eligibility-service.js";
import { estimatePatientResponsibility } from "../../intake/estimate-service.js";
import { createReferral, listReferrals, convertReferral } from "../../intake/referral-service.js";

interface Body {
  [key: string]: unknown;
}

export async function registerIntakeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/patients", async (request) => {
    const input = request.body as Body & { firstName: string; lastName: string; dateOfBirth: string; skipMatching?: boolean };
    return createPatient(await contextFor(request), { ...(input as object), firstName: input.firstName, lastName: input.lastName, dateOfBirth: new Date(input.dateOfBirth) } as never, input.skipMatching);
  });

  app.patch("/patients/:id/demographics", async (request) => {
    const input = request.body as Body;
    return updateDemographics(await contextFor(request), (request.params as { id: string }).id, input as never);
  });

  app.post("/patients/match", async (request) => {
    const input = request.body as { firstName: string; lastName: string; dateOfBirth: string; phone?: string };
    return findDuplicateCandidates(await contextFor(request), { ...input, dateOfBirth: new Date(input.dateOfBirth) });
  });

  app.get("/patients/matches/pending", async (request) => pendingMatchQueue(await contextFor(request)));
  app.post("/patients/matches/:id/resolve", async (request) => {
    const input = request.body as { resolution: "DISMISSED" | "CONFIRMED" };
    return resolveMatch(await contextFor(request), (request.params as { id: string }).id, input.resolution);
  });

  app.post("/intake/orders", async (request) => {
    const input = request.body as Body & { patientId: string; coverageId: string; branchId: string; serviceType: string; orderedBy: string; requestedVisits: number; startDate: string };
    return createIntakeOrder(await contextFor(request), { ...(input as object), startDate: new Date(input.startDate) } as never);
  });
  app.post("/intake/orders/:id/abandon", async (request) => abandonIntake(await contextFor(request), (request.params as { id: string }).id));

  app.post("/patients/:id/coverages", async (request) => {
    const input = request.body as Body & { payerId: string; memberId: string; planName: string; effectiveFrom: string };
    return addCoverage(await contextFor(request), { ...(input as object), patientId: (request.params as { id: string }).id, effectiveFrom: new Date(input.effectiveFrom) } as never);
  });
  app.post("/patients/:id/coverages/replace", async (request) => {
    const input = request.body as Body & { endDate: string; replacement: Record<string, unknown> & { effectiveFrom: string } };
    const replacement = { ...input.replacement, patientId: (request.params as { id: string }).id, effectiveFrom: new Date(input.replacement.effectiveFrom) };
    return replaceCoverage(await contextFor(request), (request.params as { id: string }).id, new Date(input.endDate), replacement as never);
  });
  app.get("/patients/:id/coverages", async (request) => coverageHistory(await contextFor(request), (request.params as { id: string }).id));

  app.post("/coverages/:id/eligibility", async (request) => runEligibilityCheck(await contextFor(request), (request.params as { id: string }).id));

  app.get("/patients/:id/estimate", async (request) => {
    const query = request.query as { serviceType: string; visits?: string };
    return estimatePatientResponsibility(await contextFor(request), (request.params as { id: string }).id, query.serviceType, Number(query.visits ?? 1));
  });

  app.post("/referrals", async (request) => createReferral(await contextFor(request), request.body as never));
  app.get("/referrals", async (request) => listReferrals(await contextFor(request), (request.query as { status?: string }).status));
  app.post("/referrals/:id/convert", async (request) => {
    const input = request.body as { patientId: string };
    return convertReferral(await contextFor(request), (request.params as { id: string }).id, input.patientId);
  });
}
