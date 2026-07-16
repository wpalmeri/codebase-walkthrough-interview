export interface ReportCatalogEntry {
  key: string;
  name: string;
  category: "operations" | "clinical" | "financial" | "admin";
  description: string;
  /** Gated by financialReportGate in run-report.ts. */
  financial: boolean;
  parameters: Array<{ name: string; type: "date" | "string" | "number"; required: boolean }>;
}

const WINDOW_PARAMS: ReportCatalogEntry["parameters"] = [
  { name: "start", type: "date", required: false },
  { name: "end", type: "date", required: false },
];

/**
 * Canonical registry of canned reports. run-report.ts dispatches on `key`;
 * the UI report picker renders name/description/parameters from here.
 */
export const REPORT_CATALOG: ReportCatalogEntry[] = [
  {
    key: "operations-dashboard",
    name: "Operations Dashboard",
    category: "operations",
    description: "Home-screen KPI cards, weekly visit volume, and exception queues.",
    // The dashboard shows open AR and unapplied cash, but it has always been
    // available to every role; flagging it financial would break the home screen.
    financial: false,
    parameters: WINDOW_PARAMS,
  },
  {
    key: "revenue-summary",
    name: "Revenue Summary",
    category: "financial",
    description: "Revenue by service type and branch, priced from posted charges with a current-rate fallback.",
    financial: true,
    parameters: WINDOW_PARAMS,
  },
  {
    key: "claim-aging",
    name: "Claim Aging",
    category: "financial",
    description: "Open claim balances bucketed by age (30/60/90, or weekly for configured customers).",
    financial: true,
    parameters: [{ name: "asOf", type: "date", required: false }],
  },
  {
    key: "cash-reconciliation",
    name: "Cash Reconciliation",
    category: "financial",
    description: "Payments received in the window with applied vs. stored unapplied variances.",
    financial: true,
    parameters: WINDOW_PARAMS,
  },
  {
    key: "clinician-productivity",
    name: "Clinician Productivity",
    category: "clinical",
    description: "Per-clinician visit counts, delivered minutes, revenue per visit, and documentation compliance.",
    // Grouped with the clinical reports; the revenue-per-visit column predates
    // the financial flag and was never reclassified.
    financial: false,
    parameters: WINDOW_PARAMS,
  },
  {
    key: "documentation-backlog",
    name: "Documentation Backlog",
    category: "clinical",
    description: "Completed visits still missing a signed note, oldest first.",
    financial: false,
    parameters: [{ name: "asOf", type: "date", required: false }],
  },
  {
    key: "monthly-census",
    name: "Monthly Patient Census",
    category: "operations",
    description: "Distinct patients served in the month plus several census definitions in use.",
    financial: false,
    parameters: WINDOW_PARAMS,
  },
  {
    key: "authorization-utilization",
    name: "Authorization Utilization",
    category: "clinical",
    description: "Visits used against payer authorization limits, with near-limit flags.",
    financial: false,
    parameters: [],
  },
  {
    key: "pricing-export",
    name: "Pricing Export",
    category: "financial",
    description: "Rate resolution detail for completed visits in the last 90 days.",
    financial: true,
    parameters: [],
  },
  {
    key: "branch-audit",
    name: "Branch Access Audit",
    category: "admin",
    description: "Audit events and visit-level access rows for one branch, for compliance requests.",
    financial: false,
    parameters: [
      { name: "branchId", type: "string", required: true },
      ...WINDOW_PARAMS,
    ],
  },
  {
    key: "custom-visits",
    name: "Custom Visit Report",
    category: "operations",
    description: "Paginated visit listing with custom-field values and optional column selection.",
    financial: false,
    parameters: [
      ...WINDOW_PARAMS,
      { name: "branchIds", type: "string", required: false },
      { name: "page", type: "number", required: false },
      { name: "pageSize", type: "number", required: false },
    ],
  },
  {
    key: "enterprise-export",
    name: "Enterprise Data Extract",
    category: "admin",
    description: "Full visit graph for warehouse ingestion (enterprise customers).",
    // The extract predates the financial flag; it ships charges and claims
    // context but is registered as an operational feed.
    financial: false,
    parameters: [],
  },
];

export function findReportEntry(key: string): ReportCatalogEntry | undefined {
  return REPORT_CATALOG.find((entry) => entry.key === key);
}
