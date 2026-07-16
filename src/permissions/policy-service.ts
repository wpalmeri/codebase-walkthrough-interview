import type { RequestContext } from "../lib/context.js";
import { ForbiddenError } from "../lib/errors.js";

/**
 * Newer declarative permission layer, started ahead of the enterprise deal.
 * Only the endpoints added since March check policies here; everything else
 * still uses requireRole()/canSeeFinancials() from legacy-authorization.ts.
 *
 * TODO(platform): region scope, team scope, patient-assignment scope,
 * delegated access (DelegatedAccess table exists but nothing reads it).
 */

export type PolicyAction =
  | "patient.read"
  | "patient.write"
  | "patient.merge"
  | "visit.read"
  | "visit.write"
  | "note.write"
  | "note.sign"
  | "claim.read"
  | "claim.write"
  | "payment.write"
  | "period.close"
  | "report.run"
  | "report.financial"
  | "workflow.manage"
  | "ai.run"
  | "ai.approve"
  | "admin.users";

const MATRIX: Record<string, PolicyAction[]> = {
  ADMIN: [
    "patient.read", "patient.write", "patient.merge", "visit.read", "visit.write", "note.write", "note.sign",
    "claim.read", "claim.write", "payment.write", "period.close", "report.run", "report.financial",
    "workflow.manage", "ai.run", "ai.approve", "admin.users",
  ],
  CLINICIAN: ["patient.read", "patient.write", "visit.read", "visit.write", "note.write", "note.sign", "report.run", "ai.run"],
  BILLER: ["patient.read", "visit.read", "claim.read", "claim.write", "payment.write", "report.run", "report.financial", "ai.run", "ai.approve"],
  VIEWER: ["patient.read", "visit.read", "report.run"],
};

export function isAllowed(context: RequestContext, action: PolicyAction): boolean {
  return (MATRIX[context.role] ?? []).includes(action);
}

export function requirePolicy(context: RequestContext, action: PolicyAction): void {
  if (!isAllowed(context, action)) {
    throw new ForbiddenError(`${context.role} may not perform ${action}`);
  }
}

export function policyMatrix(): Record<string, PolicyAction[]> {
  return MATRIX;
}
