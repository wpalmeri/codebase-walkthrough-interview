import type { FastifyInstance } from "fastify";
import { contextFor } from "../request-context.js";
import { calculatePeriod, closePeriod, periodFinancials, addPeriodAdjustment } from "../../accounting/month-close.js";
import { listPeriods, reopenPeriod } from "../../accounting/period-service.js";
import { importPayment, applyCash, reverseCashApplication, reconciliation, unappliedCashSummary, listPayments } from "../../accounting/cash-application.js";
import { importRemittanceFile, processRemittanceFile, listRemittanceFiles } from "../../accounting/remittance-import.js";
import { cashReconciliation } from "../../accounting/reconciliation.js";
import { arAging } from "../../accounting/ar-service.js";

function toDate(value: unknown): Date {
  return new Date(String(value));
}

export async function registerAccountingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/accounting/periods", async (request) => listPeriods(await contextFor(request)));
  app.get("/accounting/periods/:id/preview", async (request) => calculatePeriod((request.params as { id: string }).id));
  app.get("/accounting/periods/:id/financials", async (request) => periodFinancials((request.params as { id: string }).id));
  app.post("/accounting/periods/:id/close", async (request) => {
    const context = await contextFor(request);
    return closePeriod((request.params as { id: string }).id, context.userId);
  });
  app.post("/accounting/periods/:id/reopen", async (request) => {
    const input = request.body as { reason: string };
    return reopenPeriod(await contextFor(request), (request.params as { id: string }).id, input.reason);
  });
  app.post("/accounting/periods/:id/adjustments", async (request) => {
    const context = await contextFor(request);
    const input = request.body as { description: string; amount: number };
    return addPeriodAdjustment((request.params as { id: string }).id, input.description, input.amount, context.userId);
  });

  app.post("/payments", async (request) => {
    const input = request.body as { organizationId: string; externalId: string; amount: number; receivedAt: string };
    return importPayment(input.organizationId, input.externalId, input.amount, toDate(input.receivedAt));
  });
  app.get("/payments", async (request) => {
    const context = await contextFor(request);
    return listPayments(context.organizationId);
  });
  app.post("/payments/:id/apply", async (request) => {
    const input = request.body as { claimId: string; amount: number };
    return applyCash((request.params as { id: string }).id, input.claimId, input.amount);
  });
  app.post("/cash-applications/:id/reverse", async (request) => reverseCashApplication((request.params as { id: string }).id));

  app.post("/remittances", async (request) => {
    const context = await contextFor(request);
    return importRemittanceFile(context.organizationId, request.body as never);
  });
  app.post("/remittances/:id/process", async (request) => processRemittanceFile((request.params as { id: string }).id));
  app.get("/remittances", async (request) => {
    const context = await contextFor(request);
    return listRemittanceFiles(context.organizationId);
  });

  app.get("/accounting/reconciliation", async (request) => reconciliation((request.query as { organizationId: string }).organizationId));
  app.get("/accounting/cash-reconciliation", async (request) => {
    const query = request.query as { organizationId: string; start: string; end: string };
    return cashReconciliation(query.organizationId, toDate(query.start), toDate(query.end));
  });
  app.get("/accounting/unapplied-cash", async (request) => {
    const context = await contextFor(request);
    return unappliedCashSummary(context.organizationId);
  });
  app.get("/accounting/ar-aging", async (request) => {
    const context = await contextFor(request);
    const query = request.query as { asOf?: string };
    return arAging(context.organizationId, query.asOf ? toDate(query.asOf) : new Date());
  });
}
