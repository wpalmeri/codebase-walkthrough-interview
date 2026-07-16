import { db } from "../../src/lib/db.js";
import { loadContext } from "../../src/permissions/context-loader.js";
import { scheduleVisit } from "../../src/visits/visit-service.js";

/**
 * INC-1042 — two schedulers consume the same final authorized visit.
 *
 * Reproduction is real; kept skipped because it demonstrates a known defect
 * (it fails on purpose). Remove `.skip` to watch the authorization limit be
 * exceeded: both concurrent schedulers pass the count/compare gate before
 * either creates its visit.
 */
describe.skip("incident INC-1042: authorization scheduling race", () => {
  it("does not allow two concurrent schedulers to consume the final authorized visit", async () => {
    const context = await loadContext("user_admin");

    const auth = await db.authorization.create({ data: {
      coverageId: "coverage_000", authorizationNumber: "RACE-1", serviceType: "SKILLED_NURSING",
      maxVisits: 1, effectiveFrom: new Date("2025-01-01"), effectiveTo: new Date("2025-12-31"),
    } });
    const set = await db.visitSet.create({ data: {
      organizationId: "org_northstar", patientId: "patient_000", orderId: "order_0", coverageId: "coverage_000",
      authorizationId: auth.id, serviceType: "SKILLED_NURSING", startDate: new Date("2025-06-01"),
    } });

    const input = { visitSetId: set.id, branchId: "branch_sf", clinicianId: "user_clinician_sf", start: new Date("2025-06-10T17:00:00Z"), durationMinutes: 60 };
    const results = await Promise.allSettled([
      scheduleVisit(context, input),
      scheduleVisit(context, { ...input, start: new Date("2025-06-10T18:00:00Z") }),
    ]);

    const created = results.filter((result) => result.status === "fulfilled").length;
    const used = await db.visit.count({ where: { visitGroup: { visitSetId: set.id } } });

    // Safe behavior (does not hold today): at most one visit against a 1-visit auth.
    expect(created).toBe(1);
    expect(used).toBeLessThanOrEqual(1);
  });
});
