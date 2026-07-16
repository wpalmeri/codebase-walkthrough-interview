import type { RequestContext } from "../lib/context.js";
import { canReadFinancialData } from "../permissions/scope.js";
import { ForbiddenError } from "../lib/errors.js";

/**
 * Reporting-specific permission helpers.
 *
 * These are enforced by run-report.ts for catalog-driven runs. The direct
 * route handlers in app.ts call the report functions with a bare
 * organizationId and never pass through this module, and the scheduled-export
 * worker runs everything as systemContext(org), which satisfies every check.
 */

export function financialReportGate(context: RequestContext): void {
  if (!canReadFinancialData(context)) {
    throw new ForbiddenError("Financial reports require the ADMIN or BILLER role");
  }
}

/**
 * Branch scope for report queries; null means unscoped (org-wide).
 *
 * Only customVisitReport and runReportDefinition consult this today. The
 * canned reports (revenue, aging, cash, census, productivity, pricing) take a
 * bare organizationId and run org-wide regardless of the caller's branches.
 * Non-admin users with zero branch grants also fall through to org-wide,
 * mirroring branchScopedVisitWhere in permissions/scope.ts.
 */
export function branchFilterForReports(context: RequestContext): string[] | null {
  if (context.role === "ADMIN") return null;
  if (context.branchIds.length === 0) return null;
  return context.branchIds;
}
