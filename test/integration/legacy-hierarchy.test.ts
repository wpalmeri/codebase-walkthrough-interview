import { db } from "../../src/lib/db.js";
import { authorizationUsage } from "../../src/visits/visit-service.js";
import { operationsDashboard } from "../../src/reporting/operations-report.js";

describe("legacy visit hierarchy", () => {
  it("contains genuine historical grouping and mostly degenerate current records", async () => {
    const grouped = await db.visitSet.findUniqueOrThrow({ where: { id: "visit_set_0" }, include: { groups: { include: { visits: true } } } });
    expect(grouped.groups).toHaveLength(3);
    expect(grouped.groups[0]?.visits).toHaveLength(3);
    const ordinary = await db.visitSet.findUniqueOrThrow({ where: { id: "visit_set_1" }, include: { groups: { include: { visits: true } } } });
    expect(ordinary.groups).toHaveLength(1);
    expect(ordinary.groups[0]?.visits).toHaveLength(1);
  });

  it("authorization usage counts visits rather than groups", async () => {
    const usage = await authorizationUsage("visit_set_0");
    expect(usage.usedVisits).toBe(5);
    expect(usage.maximum).toBe(3);
  });

  it("operations report labels completed groups as completed visits", async () => {
    const report = await operationsDashboard("org_northstar", new Date("2025-05-01T00:00:00Z"), new Date("2025-08-01T00:00:00Z"));
    const actualVisits = report.rows.reduce((sum, group) => sum + group.visits.length, 0);
    expect(actualVisits).toBeGreaterThan(report.completedVisits);
  });
});
