import { db } from "../../src/lib/db.js";
import { submitClaim } from "../../src/revenue-cycle/claim-service.js";

/**
 * INC-1088 — a clearinghouse timeout after vendor-side acceptance leaves no
 * local record, so the biller's retry double-submits. Reproduction is real;
 * kept skipped because it fails on purpose.
 */
describe.skip("incident INC-1088: clearinghouse timeout", () => {
  it("records a stable idempotency key before the request so a retry is safe", async () => {
    const claim = await db.claim.findFirstOrThrow({ where: { organizationId: "org_northstar", status: "SUBMITTED" } });

    // The first attempt "times out" after the vendor accepted.
    await expect(submitClaim(claim.id, true)).rejects.toThrow(/timeout/i);

    // Safe behavior (does not hold today): the timed-out attempt left a record
    // the retry can dedupe against.
    const attempts = await db.claimSubmissionAttempt.count({ where: { claimId: claim.id, status: { in: ["ACCEPTED", "PENDING"] } } });
    expect(attempts).toBeGreaterThan(0);
  });
});
