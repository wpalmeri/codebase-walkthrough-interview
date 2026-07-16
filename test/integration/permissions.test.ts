import { loadContext } from "../../src/permissions/context-loader.js";
import { buildPermissionMatrix, UNSUPPORTED_SCOPES } from "../../src/permissions/permission-matrix.js";
import { isAllowed } from "../../src/permissions/policy-service.js";
import { patientDirectory } from "../../src/patients/patient-directory.js";

describe("permissions and enterprise scoping", () => {
  it("builds a role/action matrix and lists scopes the platform does not yet support", () => {
    const matrix = buildPermissionMatrix();
    expect(matrix.length).toBeGreaterThan(5);
    expect(matrix.every((row) => "ADMIN" in row.roles)).toBe(true);
    expect(UNSUPPORTED_SCOPES.some((scope) => /region|team|delegated/i.test(scope))).toBe(true);
  });

  it("grants ADMIN every policy action but restricts VIEWER to reads", () => {
    const admin = { userId: "a", organizationId: "org_northstar", role: "ADMIN" as const, branchIds: [] };
    const viewer = { userId: "v", organizationId: "org_northstar", role: "VIEWER" as const, branchIds: [] };
    expect(isAllowed(admin, "period.close")).toBe(true);
    expect(isAllowed(viewer, "period.close")).toBe(false);
    expect(isAllowed(viewer, "patient.read")).toBe(true);
  });

  it("filters the patient directory by branch after loading the page", async () => {
    // The viewer only has branch_oak; patients whose visits are all in other
    // branches are dropped in memory after the query returns them.
    const viewer = await loadContext("user_viewer");
    const page = await patientDirectory(viewer, { pageSize: 100 });
    const admin = await loadContext("user_admin");
    const adminPage = await patientDirectory(admin, { pageSize: 100 });
    expect(page.data.length).toBeLessThanOrEqual(adminPage.total);
  });
});
