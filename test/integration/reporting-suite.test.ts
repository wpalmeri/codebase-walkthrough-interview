import { loadContext } from "../../src/permissions/context-loader.js";
import { REPORT_CATALOG } from "../../src/reporting/report-catalog.js";
import { runReportByKey } from "../../src/reporting/run-report.js";
import { operationsDashboard } from "../../src/reporting/operations-report.js";
import { monthlyPatientCensus } from "../../src/reporting/census-report.js";
import { clinicianProductivity } from "../../src/reporting/clinician-productivity.js";

describe("reporting suite", () => {
  it("publishes a catalog whose keys the runner can dispatch", async () => {
    const context = await loadContext("user_admin");
    expect(REPORT_CATALOG.length).toBeGreaterThanOrEqual(8);
    const operational = REPORT_CATALOG.find((entry) => !entry.financial);
    const run = await runReportByKey(context, operational!.key, {});
    expect(run.runId).toBeTruthy();
  });

  it("blocks a viewer from running a financial report", async () => {
    const viewer = await loadContext("user_viewer");
    const financial = REPORT_CATALOG.find((entry) => entry.financial);
    await expect(runReportByKey(viewer, financial!.key, {})).rejects.toThrow();
  });

  it("surfaces disagreeing visit-count definitions across reports", async () => {
    const start = new Date("2025-05-01T00:00:00Z");
    const end = new Date("2025-08-01T00:00:00Z");
    const dashboard = await operationsDashboard("org_northstar", start, end);
    const census = await monthlyPatientCensus("org_northstar", start, end);
    const productivity = await clinicianProductivity("org_northstar", start, end);
    const productivityCompleted = productivity.reduce((sum, row) => sum + row.completed, 0);

    // Three definitions of "how many visits": groups-as-visits (dashboard),
    // unique patient/service-date pairs (census), and completedAt-in-window
    // (productivity). They are not equal.
    const definitions = new Set([dashboard.completedVisits, census.visits, productivityCompleted]);
    expect(definitions.size).toBeGreaterThan(1);
  });
});
