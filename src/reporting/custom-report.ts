import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { asJson } from "../lib/json.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { canAccessBranch } from "../permissions/legacy-authorization.js";
import { branchFilterForReports } from "./report-permissions.js";
import { extraExportColumns } from "../config/customer-overrides.js";
import { track } from "../events/analytics.js";

export interface CustomVisitReportRequest {
  start: Date;
  end: Date;
  branchIds?: string[];
  customField?: { key: string; value: string };
  columns?: string[];
  page?: number;
  pageSize?: number;
}

type Row = Record<string, unknown>;

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function customVisitReport(context: RequestContext, request: CustomVisitReportRequest) {
  const page = request.page ?? 1;
  const pageSize = request.pageSize ?? 100;
  const branchIds = request.branchIds ?? branchFilterForReports(context) ?? undefined;
  const where: Prisma.VisitWhereInput = {
    scheduledStart: { gte: request.start, lt: request.end },
    visitGroup: { visitSet: { organizationId: context.organizationId }, branchId: branchIds ? { in: branchIds } : undefined },
  };
  // Exact count first, then offset pagination over the same predicate.
  const total = await db.visit.count({ where });
  const visits = await db.visit.findMany({
    where,
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: { scheduledStart: "asc" },
    include: {
      patient: { include: { profile: true, demographics: true, coverages: true } },
      visitGroup: { include: { branch: true, visitSet: { include: { order: { include: { details: true } }, authorization: true } } } },
      notes: true,
      charges: { include: { lines: true } },
    },
  });

  const fieldDefinitions = request.customField
    ? await db.customFieldDefinition.findMany({ where: { organizationId: context.organizationId, entityType: "Visit" } })
    : [];
  const keyByDefinitionId = new Map(fieldDefinitions.map((definition) => [definition.id, definition.key]));

  const rows = [];
  for (const visit of visits) {
    // Branch permission is checked per row after the page is fetched, so a
    // page can come back short while total above still counts everything.
    if (!canAccessBranch(context, visit.visitGroup.branchId)) continue;
    // One custom-field lookup per visit row.
    const customFields = await db.customFieldValue.findMany({ where: { entityType: "Visit", entityId: visit.id } });
    if (request.customField) {
      const match = customFields.some(
        (value) => keyByDefinitionId.get(value.definitionId) === request.customField!.key && value.stringValue === request.customField!.value,
      );
      if (!match) continue;
    }
    const record = visit as unknown as Row;
    const projected = request.columns
      ? Object.fromEntries(request.columns.map((column) => [column, record[column] ?? null]))
      : visit;
    rows.push({ visit: projected, customFields });
  }
  track("report.customVisits", { total, returned: rows.length }, { organizationId: context.organizationId, userId: context.userId });
  return { page, pageSize, total, rows };
}

type BaseView = "VISITS" | "CLAIMS" | "PAYMENTS" | "PATIENTS";
const VIEW_ENTITY: Record<BaseView, string> = { VISITS: "Visit", CLAIMS: "Claim", PAYMENTS: "Payment", PATIENTS: "Patient" };

interface DefinitionFilter { field: string; op: "equals" | "not" | "gt" | "gte" | "lt" | "lte" | "contains" | "in"; value: unknown }
interface DefinitionCalculation { key: string; formula: "sum" | "avg" | "count"; column: string }
interface RunDefinitionParams { start?: Date; end?: Date; page?: number; pageSize?: number }

async function loadViewRows(
  context: RequestContext,
  view: BaseView,
  filters: Record<string, unknown>,
  params: RunDefinitionParams,
  skip: number,
  take: number,
): Promise<{ total: number; rows: Row[] }> {
  const window = params.start && params.end ? { gte: params.start, lt: params.end } : undefined;
  if (view === "VISITS") {
    const where = {
      ...filters,
      scheduledStart: window,
      deletedAt: null,
      visitGroup: { visitSet: { organizationId: context.organizationId } },
    } as Prisma.VisitWhereInput;
    const total = await db.visit.count({ where });
    const visits = await db.visit.findMany({
      where, skip, take, orderBy: { scheduledStart: "asc" },
      include: {
        patient: { select: { firstName: true, lastName: true } },
        visitGroup: { include: { branch: { include: { region: true } }, visitSet: { select: { id: true, serviceType: true, authorization: { select: { authorizationNumber: true } } } } } },
      },
    });
    return {
      total,
      rows: visits.map((visit) => ({
        id: visit.id,
        patientId: visit.patientId,
        patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
        clinicianId: visit.clinicianId,
        branchId: visit.visitGroup.branchId,
        branchName: visit.visitGroup.branch.name,
        regionName: visit.visitGroup.branch.region?.name ?? null,
        visitSetId: visit.visitGroup.visitSet.id,
        serviceType: visit.serviceType ?? visit.visitGroup.serviceType ?? visit.visitGroup.visitSet.serviceType,
        status: visit.status,
        scheduledStart: visit.scheduledStart,
        completedAt: visit.completedAt,
        authNumber: visit.visitGroup.visitSet.authorization?.authorizationNumber ?? null,
      })),
    };
  }
  if (view === "CLAIMS") {
    const where = { ...filters, organizationId: context.organizationId, createdAt: window } as Prisma.ClaimWhereInput;
    const total = await db.claim.count({ where });
    const claims = await db.claim.findMany({ where, skip, take, orderBy: { createdAt: "asc" } });
    return {
      total,
      rows: claims.map((claim) => ({
        id: claim.id, patientId: claim.patientId, payerId: claim.payerId, branchId: claim.branchId,
        status: claim.status, claimNumber: claim.claimNumber, totalAmount: Number(claim.totalAmount),
        balanceAmount: Number(claim.balanceAmount), submittedAt: claim.submittedAt, createdAt: claim.createdAt,
      })),
    };
  }
  if (view === "PAYMENTS") {
    const where = { ...filters, organizationId: context.organizationId, receivedAt: window } as Prisma.PaymentWhereInput;
    const total = await db.payment.count({ where });
    const payments = await db.payment.findMany({ where, skip, take, orderBy: { receivedAt: "asc" } });
    return {
      total,
      rows: payments.map((payment) => ({
        id: payment.id, externalId: payment.externalId, payerId: payment.payerId, method: payment.method,
        amount: Number(payment.amount), unappliedAmount: Number(payment.unappliedAmount), status: payment.status, receivedAt: payment.receivedAt,
      })),
    };
  }
  const where = { ...filters, organizationId: context.organizationId, deletedAt: null, createdAt: window } as Prisma.PatientWhereInput;
  const total = await db.patient.count({ where });
  const patients = await db.patient.findMany({ where, skip, take, orderBy: { lastName: "asc" } });
  return {
    total,
    rows: patients.map((patient) => ({
      id: patient.id, mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName,
      active: patient.active, primaryClinicianId: patient.primaryClinicianId, createdAt: patient.createdAt,
    })),
  };
}

function applyCalculations(rows: Row[], calculations: DefinitionCalculation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const calculation of calculations) {
    if (calculation.formula === "count") { out[calculation.key] = rows.length; continue; }
    const values = rows.map((row) => Number(row[calculation.column] ?? 0)).filter((value) => Number.isFinite(value));
    const sum = values.reduce((a, b) => a + b, 0);
    out[calculation.key] = calculation.formula === "sum" ? sum : values.length > 0 ? sum / values.length : 0;
  }
  return out;
}

/** Runs a saved ReportDefinition. */
export async function runReportDefinition(context: RequestContext, definitionId: string, params: RunDefinitionParams = {}) {
  const definition = await db.reportDefinition.findUnique({ where: { id: definitionId } });
  if (!definition || definition.organizationId !== context.organizationId) throw new NotFoundError("Report definition not found");
  const view = definition.baseView as BaseView;
  if (!VIEW_ENTITY[view]) throw new ValidationError(`Unsupported base view: ${definition.baseView}`);

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 100;
  // Filter fields are trusted as column names; a stale or hand-edited
  // definition surfaces as a Prisma validation error at run time.
  const filterWhere: Record<string, unknown> = {};
  for (const filter of jsonArray<DefinitionFilter>(definition.filters)) {
    filterWhere[filter.field] = { [filter.op]: filter.value };
  }
  const loaded = await loadViewRows(context, view, filterWhere, params, (page - 1) * pageSize, pageSize);

  let rows = loaded.rows;
  if (view === "VISITS") {
    // Same pattern as customVisitReport: rows are dropped per-branch after
    // the page is fetched. Other views have no branch concept applied.
    rows = rows.filter((row) => canAccessBranch(context, String(row.branchId)));
  }

  const organization = await db.organization.findUniqueOrThrow({ where: { id: context.organizationId } });
  const extras = organization.enterprise ? extraExportColumns(organization.slug) : [];
  const baseColumns = jsonArray<string>(definition.columns);
  const columns = [...baseColumns, ...extras.filter((column) => !baseColumns.includes(column))];
  const customDefinitions = await db.customFieldDefinition.findMany({ where: { organizationId: context.organizationId, entityType: VIEW_ENTITY[view] } });
  const definitionIdByKey = new Map(customDefinitions.map((item) => [item.key, item.id]));
  const referralDefinition = extras.includes("referral_source")
    ? await db.customFieldDefinition.findFirst({ where: { organizationId: context.organizationId, entityType: "VisitSet", key: "referral_source" } })
    : null;

  const projected: Row[] = [];
  for (const row of rows) {
    const output: Row = {};
    // Custom-field columns resolve through one EAV query per row.
    const customValues = columns.some((column) => column.startsWith("custom."))
      ? await db.customFieldValue.findMany({ where: { entityType: VIEW_ENTITY[view], entityId: String(row.id) } })
      : [];
    for (const column of columns) {
      if (column.startsWith("custom.")) {
        const wantedId = definitionIdByKey.get(column.slice("custom.".length));
        const value = customValues.find((candidate) => candidate.definitionId === wantedId);
        output[column] = value?.stringValue ?? value?.numberValue ?? value?.dateValue ?? value?.booleanValue ?? null;
      } else if (column === "region_name") {
        output[column] = row.regionName ?? null;
      } else if (column === "auth_number") {
        output[column] = row.authNumber ?? null;
      } else if (column === "referral_source") {
        const value = referralDefinition && row.visitSetId
          ? await db.customFieldValue.findFirst({ where: { definitionId: referralDefinition.id, entityId: String(row.visitSetId) } })
          : null;
        output[column] = value?.stringValue ?? null;
      } else {
        output[column] = row[column] ?? null;
      }
    }
    projected.push(output);
  }

  const groupings = jsonArray<string>(definition.groupings);
  const calculations = jsonArray<DefinitionCalculation>(definition.calculations);
  let groups: Array<{ key: Row; rowCount: number; calculations: Record<string, number> }> | undefined;
  if (groupings.length > 0) {
    // Grouping and calculations run in memory over the current page only, so
    // group totals shift as the user pages through results.
    const byKey = new Map<string, Row[]>();
    for (const row of projected) {
      const key = groupings.map((grouping) => String(row[grouping] ?? "")).join("|");
      const members = byKey.get(key);
      if (members) members.push(row);
      else byKey.set(key, [row]);
    }
    groups = [...byKey.values()].map((members) => ({
      key: Object.fromEntries(groupings.map((grouping) => [grouping, members[0]?.[grouping] ?? null])),
      rowCount: members.length,
      calculations: applyCalculations(members, calculations),
    }));
  }

  return {
    definitionId: definition.id,
    name: definition.name,
    baseView: view,
    page,
    pageSize,
    total: loaded.total,
    columns,
    rows: projected,
    groups,
    calculations: groupings.length === 0 && calculations.length > 0 ? applyCalculations(projected, calculations) : undefined,
  };
}

export interface ReportDefinitionInput {
  id?: string;
  name: string;
  description?: string;
  baseView: string;
  columns: string[];
  filters?: DefinitionFilter[];
  groupings?: string[];
  calculations?: DefinitionCalculation[];
  shared?: boolean;
}

// Any role can save definitions; `shared` is a boolean, not an ACL.
export async function saveReportDefinition(context: RequestContext, input: ReportDefinitionInput) {
  const data = {
    name: input.name,
    description: input.description ?? null,
    baseView: input.baseView,
    columns: asJson(input.columns),
    filters: asJson(input.filters ?? []),
    groupings: asJson(input.groupings ?? []),
    calculations: asJson(input.calculations ?? []),
    shared: input.shared ?? false,
  };
  if (input.id) {
    const existing = await db.reportDefinition.findUnique({ where: { id: input.id } });
    if (!existing || existing.organizationId !== context.organizationId) throw new NotFoundError("Report definition not found");
    return db.reportDefinition.update({ where: { id: input.id }, data });
  }
  return db.reportDefinition.create({ data: { ...data, organizationId: context.organizationId, createdBy: context.userId } });
}

/**
 * Warehouse feed for enterprise customers. Runs org-wide with no role or
 * branch scoping — the integrations team owns access to the route. Coverages
 * and full note content were added for the Evergreen warehouse project.
 */
export async function unsafeEnterpriseExport(organizationId: string) {
  const sets = await db.visitSet.findMany({ where: { organizationId }, select: { id: true } });
  return db.visit.findMany({
    where: { visitGroup: { visitSetId: { in: sets.map((set) => set.id) } } },
    include: {
      patient: { include: { profile: true, demographics: true, coverages: { include: { payer: true } } } },
      notes: true,
      charges: { include: { lines: true } },
      visitGroup: { include: { branch: true, visitSet: { include: { authorization: true } } } },
    },
  });
}
