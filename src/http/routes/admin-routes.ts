import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { contextFor } from "../request-context.js";
import { buildPermissionMatrix, UNSUPPORTED_SCOPES } from "../../permissions/permission-matrix.js";
import { exportAuditTrail, auditTrailForResource } from "../../audit/audit-export.js";
import { listOrders, discontinueOrder } from "../../orders/order-service.js";
import { getOrderSummary } from "../../orders/order-summary.js";

function toDate(value: unknown): Date {
  return new Date(String(value));
}

/**
 * Organization, reference-data, and admin endpoints. The org list is
 * unscoped (the switcher shows every org) — acceptable in this single-tenant
 * demo but exactly the kind of thing the enterprise review will flag.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/organizations", async () => {
    const orgs = await db.organization.findMany({ include: { regions: true, branches: true } });
    return orgs.map((org) => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
      enterprise: org.enterprise,
      regionCount: org.regions.length,
      branchCount: org.branches.length,
    }));
  });

  app.get("/organizations/:id/branches", async (request) => {
    return db.branch.findMany({ where: { organizationId: (request.params as { id: string }).id }, include: { region: true, teams: true } });
  });

  app.get("/organizations/:id/users", async (request) => {
    return db.user.findMany({
      where: { organizationId: (request.params as { id: string }).id },
      include: { branchAccess: true, clinicianProfile: true },
      orderBy: { displayName: "asc" },
    });
  });

  app.get("/reference/payers", async () => db.payer.findMany({ include: { contracts: { include: { rates: true } } } }));
  app.get("/reference/clinicians", async (request) => {
    const context = await contextFor(request);
    return db.user.findMany({ where: { organizationId: context.organizationId, role: "CLINICIAN", active: true }, include: { clinicianProfile: true } });
  });

  app.get("/orders", async (request) => listOrders(await contextFor(request), (request.query as { status?: string }).status));
  app.get("/orders/:id", async (request) => getOrderSummary((request.params as { id: string }).id));
  app.post("/orders/:id/discontinue", async (request) => {
    const input = request.body as { reason: string };
    return discontinueOrder(await contextFor(request), (request.params as { id: string }).id, input.reason);
  });

  app.get("/admin/permissions", async () => ({ matrix: buildPermissionMatrix(), unsupportedScopes: UNSUPPORTED_SCOPES }));

  app.get("/admin/audit", async (request) => {
    const context = await contextFor(request);
    const query = request.query as { start: string; end: string; resourceType?: string; actorId?: string };
    return exportAuditTrail(context, toDate(query.start), toDate(query.end), { resourceType: query.resourceType, actorId: query.actorId });
  });
  app.get("/admin/audit/:resourceType/:resourceId", async (request) => {
    const params = request.params as { resourceType: string; resourceId: string };
    return auditTrailForResource(await contextFor(request), params.resourceType, params.resourceId);
  });
}
