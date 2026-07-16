import { UserRole } from "@prisma/client";
import { canAccessBranch, canSeeFinancials, requireSameOrganization } from "../../src/permissions/legacy-authorization.js";
import type { RequestContext } from "../../src/lib/context.js";

function context(role: UserRole): RequestContext {
  return { userId: "user", organizationId: "org_a", role, branchIds: ["branch_a"] };
}

describe("legacy authorization", () => {
  it("grants administrators access without checking branch membership", () => {
    expect(canAccessBranch(context(UserRole.ADMIN), "branch_other")).toBe(true);
  });

  it("allows an administrator to pass a different organization", () => {
    expect(() => requireSameOrganization(context(UserRole.ADMIN), "org_b")).not.toThrow();
  });

  it("limits financial screens to administrators and billers", () => {
    expect(canSeeFinancials(context(UserRole.BILLER))).toBe(true);
    expect(canSeeFinancials(context(UserRole.CLINICIAN))).toBe(false);
  });
});
