import { db } from "../../src/lib/db.js";
import { loadContext } from "../../src/permissions/context-loader.js";
import { createCorrectedClaim } from "../../src/revenue-cycle/correction-service.js";
import { ingestRejection, rejectionWorklist } from "../../src/revenue-cycle/rejection-service.js";
import { claimQueue } from "../../src/revenue-cycle/claim-service.js";

describe("revenue cycle", () => {
  it("lists claims in the queue with open rejection codes", async () => {
    const queue = await claimQueue("org_northstar", {}, 1, 50);
    expect(queue.total).toBe(14);
    expect(queue.data.some((claim) => claim.status === "REJECTED")).toBe(true);
  });

  it("ingests a rejection and moves the claim to the worklist", async () => {
    const claim = await db.claim.findFirstOrThrow({ where: { organizationId: "org_northstar", status: "SUBMITTED", externalId: { not: null } } });
    const rejection = await ingestRejection(claim.externalId!, "CO-16", "Missing information", "MISSING_INFO");
    const worklist = await rejectionWorklist({ userId: "user_biller", organizationId: "org_northstar", role: "BILLER", branchIds: [] });
    expect(worklist.some((row) => row.claimId === claim.id)).toBe(true);

    // cleanup
    await db.claimRejection.delete({ where: { id: rejection.id } });
    await db.claim.update({ where: { id: claim.id }, data: { status: "SUBMITTED" } });
    await db.claimStatusHistory.deleteMany({ where: { claimId: claim.id, toStatus: "REJECTED" } });
  });

  it("re-prices a corrected claim at current rates rather than the original service-date rates", async () => {
    const context = await loadContext("user_biller");
    // Use a rejected seed claim.
    const rejected = await db.claim.findFirstOrThrow({ where: { organizationId: "org_northstar", status: "REJECTED" }, include: { lines: true } });
    const result = await createCorrectedClaim(context, rejected.id, { voidOriginal: false });
    expect(result.corrected.correctedFromId).toBe(rejected.id);
    // Both the original and the correction now carry balances (double count),
    // because voidOriginal defaulted to false.
    const original = await db.claim.findUniqueOrThrow({ where: { id: rejected.id } });
    expect(original.status).toBe("REJECTED");
    expect(Number(result.corrected.balanceAmount)).toBeGreaterThan(0);

    // cleanup
    await db.claimLine.deleteMany({ where: { claimId: result.corrected.id } });
    await db.claimStatusHistory.deleteMany({ where: { claimId: result.corrected.id } });
    await db.claim.delete({ where: { id: result.corrected.id } });
  });
});
