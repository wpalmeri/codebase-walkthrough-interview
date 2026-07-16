import { db } from "../lib/db.js";
import { loadContext } from "../permissions/context-loader.js";
import { operationsDashboard } from "../reporting/operations-report.js";
import { documentationBacklogRows } from "../documentation/completeness-service.js";
import { claimQueue } from "../revenue-cycle/claim-service.js";
import { rejectionWorklist } from "../revenue-cycle/rejection-service.js";
import { visitDetail } from "../visits/visit-detail.js";
import { patientHeader } from "../patients/patient-header.js";
import { periodFinancials } from "../accounting/month-close.js";
import { unappliedCashSummary } from "../accounting/cash-application.js";
import { arAging } from "../accounting/ar-service.js";
import { buildPermissionMatrix, UNSUPPORTED_SCOPES } from "../permissions/permission-matrix.js";
import { REPORT_CATALOG } from "../reporting/report-catalog.js";
import { listAiRuns } from "../ai-employee/operations-agent.js";
import { aiQualitySnapshot } from "../ai-employee/evaluation.js";

const DEMO_USER: Record<string, string> = {
  org_northstar: "user_admin",
  org_lakeside: "user_lakeside",
  org_evergreen: "ev_user_admin",
};

function demoUser(organizationId: string): string {
  return DEMO_USER[organizationId] ?? "user_admin";
}

// ---------------------------------------------------------------------------
// Org switcher
// ---------------------------------------------------------------------------
export async function organizationList() {
  const orgs = await db.organization.findMany({ include: { regions: true, branches: true }, orderBy: { name: "asc" } });
  return orgs.map((org) => ({
    id: org.id,
    slug: org.slug,
    name: org.name,
    enterprise: org.enterprise,
    regions: org.regions.length,
    branches: org.branches.length,
  }));
}

// ---------------------------------------------------------------------------
// Dashboard (fields asserted by test/integration/ui.test.ts must remain)
// ---------------------------------------------------------------------------
export async function dashboardData(organizationId: string) {
  const [patients, visits, completed, unsigned, claims, rejected, periods, recentVisits] = await Promise.all([
    db.patient.count({ where: { organizationId, active: true, deletedAt: null } }),
    db.visit.count({ where: { visitGroup: { visitSet: { organizationId } }, deletedAt: null } }),
    db.visit.count({ where: { visitGroup: { visitSet: { organizationId } }, status: "COMPLETED", deletedAt: null } }),
    db.visit.count({ where: { visitGroup: { visitSet: { organizationId }, documentationStatus: { not: "SIGNED" } }, status: "COMPLETED" } }),
    db.claim.aggregate({ where: { organizationId }, _sum: { totalAmount: true, balanceAmount: true }, _count: true }),
    db.claim.count({ where: { organizationId, status: "REJECTED" } }),
    db.accountingPeriod.findMany({ where: { organizationId }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
    db.visit.findMany({ where: { visitGroup: { visitSet: { organizationId } } }, take: 8, orderBy: { scheduledStart: "desc" }, include: { patient: true, visitGroup: { include: { branch: true, visitSet: true } }, notes: true, charges: true } }),
  ]);

  const [unappliedCash, openTasks, pendingEvents] = await Promise.all([
    db.payment.aggregate({ where: { organizationId, unappliedAmount: { gt: 0 } }, _sum: { unappliedAmount: true } }),
    db.taskRecord.count({ where: { organizationId, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    db.domainEvent.count({ where: { organizationId, processedAt: null } }),
  ]);

  // Eight ISO weeks of visit volume, one query per week (deliberately).
  // Anchored on the org's most recent visit so the chart reflects the seeded
  // world rather than wall-clock "now".
  const weeklyVolume: Array<{ weekStart: string; count: number }> = [];
  const latestVisit = await db.visit.findFirst({
    where: { visitGroup: { visitSet: { organizationId } }, deletedAt: null },
    orderBy: { scheduledStart: "desc" },
    select: { scheduledStart: true },
  });
  const anchor = latestVisit ? new Date(latestVisit.scheduledStart) : new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  anchor.setTime(anchor.getTime() + 7 * 86_400_000); // include the latest visit's week
  for (let week = 7; week >= 0; week -= 1) {
    const start = new Date(anchor.getTime() - week * 7 * 86_400_000);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    const count = await db.visit.count({
      where: { visitGroup: { visitSet: { organizationId } }, scheduledStart: { gte: start, lt: end }, deletedAt: null },
    });
    weeklyVolume.push({ weekStart: start.toISOString().slice(0, 10), count });
  }

  return {
    metrics: {
      activePatients: patients,
      visits,
      completed,
      documentationBacklog: unsigned,
      claimCount: claims._count,
      rejectedClaims: rejected,
      expectedRevenue: Number(claims._sum.totalAmount ?? 0),
      outstandingReceivables: Number(claims._sum.balanceAmount ?? 0),
      unappliedCash: Number(unappliedCash._sum.unappliedAmount ?? 0),
      openTasks,
      pendingEvents,
    },
    weeklyVolume,
    periods,
    recentVisits: recentVisits.map((visit) => ({
      id: visit.id,
      patient: `${visit.patient.firstName} ${visit.patient.lastName}`,
      patientId: visit.patientId,
      serviceType: visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
      branch: visit.visitGroup.branch.name,
      scheduledStart: visit.scheduledStart,
      status: visit.status,
      documentationStatus: visit.visitGroup.documentationStatus,
      hasCharge: visit.charges.length > 0,
    })),
  };
}

/** Exception queues + KPI extras for the dashboard, from the operations report. */
export async function dashboardExceptions(organizationId: string) {
  const context = { userId: demoUser(organizationId), organizationId, role: "ADMIN" as const, branchIds: [] };
  const dashboard = await operationsDashboard(organizationId, new Date(Date.now() - 30 * 86_400_000), new Date());
  const backlog = await documentationBacklogRows(organizationId, 8);
  void context;
  return { dashboard, documentationPreview: backlog };
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------
export async function patientDirectory(organizationId: string, query = "") {
  const patients = await db.patient.findMany({
    where: { organizationId, deletedAt: null, OR: query ? [
      { firstName: { contains: query, mode: "insensitive" } },
      { lastName: { contains: query, mode: "insensitive" } },
      { externalId: { contains: query, mode: "insensitive" } },
    ] : undefined },
    take: 100,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: { profile: true, coverages: { include: { payer: true } }, visits: { orderBy: { scheduledStart: "desc" }, take: 1 } },
  });
  return patients.map((patient) => ({
    id: patient.id,
    externalId: patient.externalId,
    name: `${patient.firstName} ${patient.lastName}`,
    preferredName: patient.profile?.preferredName,
    dateOfBirth: patient.dateOfBirth,
    phone: patient.profile?.phone,
    payer: patient.coverages[0]?.payer.name ?? "Self pay",
    active: patient.active,
    lastVisit: patient.visits[0]?.scheduledStart ?? null,
  }));
}

export async function patientDetail(patientId: string) {
  const header = await patientHeader(patientId);
  const coverages = await db.insuranceCoverage.findMany({ where: { patientId }, include: { payer: true }, orderBy: { effectiveFrom: "desc" } });
  const visitSets = await db.visitSet.findMany({
    where: { patientId },
    include: { authorization: true, order: true, groups: { include: { visits: true } } },
    orderBy: { startDate: "desc" },
  });
  const recentVisits = await db.visit.findMany({
    where: { patientId }, orderBy: { scheduledStart: "desc" }, take: 10,
    include: { visitGroup: { include: { branch: true } }, notes: true },
  });
  return {
    header,
    coverages: coverages.map((coverage) => ({ id: coverage.id, payer: coverage.payer.name, plan: coverage.planName, memberId: coverage.memberId, effectiveFrom: coverage.effectiveFrom, verified: Boolean(coverage.verifiedAt) })),
    visitSets: visitSets.map((set) => ({
      id: set.id,
      serviceType: set.serviceType,
      status: set.status,
      billingStatus: set.billingStatus,
      groupCount: set.groups.length,
      visitCount: set.groups.reduce((sum, group) => sum + group.visits.length, 0),
      authorization: set.authorization ? { number: set.authorization.authorizationNumber, maxVisits: set.authorization.maxVisits } : null,
    })),
    recentVisits: recentVisits.map((visit) => ({
      id: visit.id, status: visit.status, scheduledStart: visit.scheduledStart,
      branch: visit.visitGroup.branch.name, signed: visit.notes.some((note) => note.status === "SIGNED"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------
export async function visitList(organizationId: string, filters: { status?: string; branchId?: string; q?: string } = {}) {
  const visits = await db.visit.findMany({
    where: {
      visitGroup: { visitSet: { organizationId }, branchId: filters.branchId },
      deletedAt: null,
      status: filters.status as never,
      patient: filters.q ? { OR: [{ firstName: { contains: filters.q, mode: "insensitive" } }, { lastName: { contains: filters.q, mode: "insensitive" } }] } : undefined,
    },
    orderBy: { scheduledStart: "desc" },
    take: 100,
    include: { patient: true, visitGroup: { include: { branch: true, visitSet: true } }, notes: true, charges: true },
  });
  return visits.map((visit) => ({
    id: visit.id,
    patient: `${visit.patient.lastName}, ${visit.patient.firstName}`,
    patientId: visit.patientId,
    serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
    branch: visit.visitGroup.branch.name,
    scheduledStart: visit.scheduledStart,
    status: visit.status,
    documentationStatus: visit.visitGroup.documentationStatus,
    signed: visit.notes.some((note) => note.status === "SIGNED"),
    hasCharge: visit.charges.length > 0,
    visitSetId: visit.visitGroup.visitSetId,
    visitGroupId: visit.visitGroupId,
  }));
}

export async function visitDrawer(visitId: string) {
  return visitDetail(visitId);
}

export async function documentationBacklog(organizationId: string) {
  const rows = await documentationBacklogRows(organizationId, 100);
  return { total: rows.length, rows };
}

// ---------------------------------------------------------------------------
// Revenue cycle
// ---------------------------------------------------------------------------
export async function claimsQueue(organizationId: string) {
  const claims = await db.claim.findMany({
    where: { organizationId }, orderBy: { createdAt: "desc" },
    include: { lines: true, attempts: { orderBy: { attemptedAt: "desc" } }, applications: true, rejections: { where: { resolvedAt: null } } },
  });
  const patientIds = [...new Set(claims.map((claim) => claim.patientId))];
  const patients = await db.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, firstName: true, lastName: true } });
  const names = new Map(patients.map((patient) => [patient.id, `${patient.firstName} ${patient.lastName}`]));
  return claims.map((claim) => ({
    id: claim.id,
    patientId: claim.patientId,
    patient: names.get(claim.patientId) ?? claim.patientId,
    status: claim.status,
    externalId: claim.externalId,
    claimNumber: claim.claimNumber,
    total: Number(claim.totalAmount),
    balance: Number(claim.balanceAmount),
    submittedAt: claim.submittedAt,
    attempts: claim.attempts.length,
    applications: claim.applications.length,
    openRejections: claim.rejections.map((rejection) => rejection.code),
  }));
}

export async function rejections(organizationId: string) {
  return rejectionWorklist({ userId: demoUser(organizationId), organizationId, role: "BILLER", branchIds: [] });
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------
export async function accountingOverview(organizationId: string) {
  const [periods, payments, postings] = await Promise.all([
    db.accountingPeriod.findMany({ where: { organizationId }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
    db.payment.findMany({ where: { organizationId }, include: { applications: true }, orderBy: { receivedAt: "desc" }, take: 50 }),
    db.financialPosting.findMany({ where: { organizationId }, orderBy: { postingDate: "desc" }, take: 50 }),
  ]);
  return {
    periods,
    payments: payments.map((payment) => ({ ...payment, amount: Number(payment.amount), unappliedAmount: Number(payment.unappliedAmount), applied: payment.applications.reduce((sum, item) => sum + Number(item.amount), 0) })),
    postings: postings.map((posting) => ({ ...posting, amount: Number(posting.amount) })),
  };
}

export async function monthCloseDetail(organizationId: string, periodId?: string) {
  const period = periodId
    ? await db.accountingPeriod.findUnique({ where: { id: periodId } })
    : await db.accountingPeriod.findFirst({ where: { organizationId }, orderBy: [{ year: "desc" }, { month: "desc" }] });
  if (!period) return { period: null, financials: null };
  const financials = await periodFinancials(period.id);
  const unapplied = await unappliedCashSummary(organizationId);
  const aging = await arAging(organizationId);
  return { period, financials, unappliedCash: unapplied, aging };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
export async function reportsOverview(organizationId: string) {
  const recentRuns = await db.reportRun.findMany({ where: { organizationId }, orderBy: { startedAt: "desc" }, take: 20 });
  const definitions = await db.reportDefinition.findMany({ where: { organizationId } });
  return { catalog: REPORT_CATALOG, recentRuns, definitions };
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------
export async function automationOverview(organizationId: string) {
  const [workflows, pendingEvents, recentExecutions, webhooks] = await Promise.all([
    db.workflowDefinition.findMany({ where: { organizationId }, include: { executions: { orderBy: { startedAt: "desc" }, take: 5 } }, orderBy: { name: "asc" } }),
    db.domainEvent.count({ where: { organizationId, processedAt: null } }),
    db.workflowExecution.findMany({ where: { workflow: { organizationId } }, include: { workflow: true }, orderBy: { startedAt: "desc" }, take: 20 }),
    db.webhookEndpoint.findMany({ where: { organizationId } }),
  ]);
  return { workflows, pendingEvents, recentExecutions, webhooks };
}

// ---------------------------------------------------------------------------
// AI employee
// ---------------------------------------------------------------------------
export async function aiWorkspace(organizationId: string) {
  const [runs, quality] = await Promise.all([listAiRuns(organizationId, 15), aiQualitySnapshot(organizationId)]);
  return { runs, quality };
}

// ---------------------------------------------------------------------------
// Permissions matrix + tasks
// ---------------------------------------------------------------------------
export async function permissionsView() {
  return { matrix: buildPermissionMatrix(), unsupportedScopes: UNSUPPORTED_SCOPES };
}

export async function tasksView(organizationId: string) {
  const tasks = await db.taskRecord.findMany({ where: { organizationId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 100 });
  return tasks;
}

/** Resolve a request's demo user so UI POST actions attach a plausible actor. */
export async function uiContext(organizationId: string) {
  return loadContext(demoUser(organizationId));
}
