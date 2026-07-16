import { vi } from "vitest";
import { db } from "../../src/lib/db.js";
import { getVisitResponse } from "../../src/visits/visit-read-service.js";
import { monthlyPatientCensus } from "../../src/reporting/census-report.js";
import { documentationBacklog } from "../../src/reporting/documentation-report.js";
import { authorizationUtilization } from "../../src/reporting/authorization-report.js";
import { clinicianProductivity } from "../../src/reporting/clinician-productivity.js";
import { investigateBillingBlockers } from "../../src/ai-employee/operations-agent.js";
import { processEvent } from "../../src/workflows/workflow-runner.js";
import { applyCash, importPayment, reconciliation } from "../../src/accounting/cash-application.js";

describe("platform breadth", () => {
  it("maps database records through legacy, domain, and API representations", async () => {
    const response = await getVisitResponse("visit_0_0_0");
    expect(response).toMatchObject({
      id: "visit_0_0_0",
      visitSetId: "visit_set_0",
      visitGroupId: "visit_group_0_0",
      serviceType: "SKILLED_NURSING",
      status: "COMPLETED",
    });
    expect(response.deliveredMinutes).toBe(45);
  });

  it("surfaces competing census definitions", async () => {
    const census = await monthlyPatientCensus("org_northstar", new Date("2025-05-01"), new Date("2025-08-01"));
    expect(census.activeFlag).toBe(36);
    expect(census.patientsWithVisits).toBe(36);
    expect(census.patientsWithCompletedVisitGroups).toBe(36);
  });

  it("reports documentation at visit grain after selecting groups", async () => {
    const backlog = await documentationBacklog("org_northstar", new Date("2025-08-01"));
    expect(backlog.total).toBeGreaterThan(0);
    expect(backlog.rows.some((row) => row.visitId === "visit_0_0_0")).toBe(true);
  });

  it("calculates authorization usage from nested records", async () => {
    const rows = await authorizationUtilization("org_northstar");
    const overused = rows.find((row) => row.authorizationId === "auth_0");
    expect(overused?.remaining).toBe(-2);
  });

  it("performs per-clinician count queries for productivity", async () => {
    const rows = await clinicianProductivity("org_northstar", new Date("2025-05-01"), new Date("2025-08-01"));
    // One row per active northstar clinician; only the seeded primary
    // clinician has completed visits, the rest come back with zeros.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const primary = rows.find((row) => row.clinicianId === "user_clinician_sf");
    expect(primary?.completed).toBeGreaterThan(36);
  });

  it("runs the deterministic AI prototype without a model API key", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const run = await investigateBillingBlockers("org_northstar", "user_admin");
    expect(run.status).toBe("COMPLETED");
    expect(run.response).toContain("missing signed documentation");
    await db.aiToolInvocation.deleteMany({ where: { runId: run.id } });
    await db.aiProposedAction.deleteMany({ where: { runId: run.id } });
    await db.aiRun.delete({ where: { id: run.id } });
    log.mockRestore();
  });

  it("executes a supported local workflow action", async () => {
    const workflow = await db.workflowDefinition.create({ data: {
      organizationId: "org_northstar", name: "Test audit", eventName: "test.event",
      condition: { field: "status", op: "equals", value: "READY" }, actions: [{ type: "audit", message: "observed" }], enabled: true,
    } });
    const event = await db.domainEvent.create({ data: { organizationId: "org_northstar", eventName: "test.event", aggregateType: "Test", aggregateId: "1", payload: { status: "READY" } } });
    const executions = await processEvent(event.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("COMPLETED");
    await db.workflowExecution.deleteMany({ where: { workflowId: workflow.id } });
    await db.workflowDefinition.delete({ where: { id: workflow.id } });
    await db.domainEvent.delete({ where: { id: event.id } });
  });

  it("allows a retry to apply the same cash twice", async () => {
    const charge = await db.charge.create({ data: {
      id: "test_cash_charge", visitId: "visit_1_0_0", status: "POSTED", totalAmount: 100,
      lines: { create: { id: "test_cash_line", serviceCode: "TEST", units: 1, unitPrice: 100, amount: 100 } },
    } });
    const claim = await db.claim.create({ data: {
      id: "test_cash_claim", organizationId: "org_northstar", patientId: "patient_001", payerId: "payer_acme",
      status: "ACCEPTED", totalAmount: 100, balanceAmount: 100,
      lines: { create: { id: "test_cash_claim_line", chargeLineId: "test_cash_line", amount: 100 } },
    } });
    const payment = await importPayment("org_northstar", `TEST-${Date.now()}`, 100, new Date());
    await applyCash(payment.id, claim.id, 60);
    await applyCash(payment.id, claim.id, 60);
    const differences = await reconciliation("org_northstar");
    const current = await db.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(current.balanceAmount.toNumber()).toBe(-20);
    expect(differences.find((row) => row.paymentId === payment.id)?.matches).toBe(true);
    await db.cashApplication.deleteMany({ where: { paymentId: payment.id } });
    await db.payment.delete({ where: { id: payment.id } });
    await db.claimLine.deleteMany({ where: { claimId: claim.id } });
    await db.claim.delete({ where: { id: claim.id } });
    await db.chargeLine.deleteMany({ where: { chargeId: charge.id } });
    await db.charge.delete({ where: { id: charge.id } });
  });
});
