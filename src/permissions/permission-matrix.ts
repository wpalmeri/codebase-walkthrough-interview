import { UserRole } from "@prisma/client";
import { policyMatrix, type PolicyAction } from "./policy-service.js";

/**
 * Data backing the admin "Permissions" screen. The matrix reflects the new
 * policy layer only; screens gated by requireRole()/canSeeFinancials() are
 * annotated by hand below and drift from the enforcement code.
 */

export interface MatrixRow {
  action: PolicyAction | string;
  label: string;
  roles: Record<string, boolean>;
  enforcement: "policy" | "legacy" | "mixed";
}

const LABELS: Record<string, string> = {
  "patient.read": "View patients",
  "patient.write": "Edit patients",
  "patient.merge": "Merge duplicate patients",
  "visit.read": "View visits",
  "visit.write": "Schedule and complete visits",
  "note.write": "Write clinical notes",
  "note.sign": "Sign clinical notes",
  "claim.read": "View claims",
  "claim.write": "Create and submit claims",
  "payment.write": "Post and apply payments",
  "period.close": "Close accounting periods",
  "report.run": "Run reports",
  "report.financial": "Run financial reports",
  "workflow.manage": "Manage workflow automations",
  "ai.run": "Use the AI employee",
  "ai.approve": "Approve AI proposed actions",
  "admin.users": "Manage users and access",
};

export function buildPermissionMatrix(): MatrixRow[] {
  const matrix = policyMatrix();
  const actions = new Set<string>();
  for (const list of Object.values(matrix)) for (const action of list) actions.add(action);

  const rows: MatrixRow[] = [...actions].sort().map((action) => ({
    action,
    label: LABELS[action] ?? action,
    roles: Object.fromEntries(
      Object.values(UserRole).map((role) => [role, (matrix[role] ?? []).includes(action as PolicyAction)]),
    ),
    enforcement: "policy" as const,
  }));

  rows.push(
    {
      action: "export.enterprise",
      label: "Run enterprise data exports",
      roles: { ADMIN: true, CLINICIAN: false, BILLER: true, VIEWER: false },
      enforcement: "legacy",
    },
    {
      action: "audit.export",
      label: "Export audit history",
      roles: { ADMIN: true, CLINICIAN: false, BILLER: false, VIEWER: false },
      enforcement: "mixed",
    },
  );
  return rows;
}

export const UNSUPPORTED_SCOPES = [
  "region-scoped access",
  "team-scoped access",
  "assigned-patient scoping",
  "delegated access (table exists, unenforced)",
  "temporary elevated access with audit trail",
];
