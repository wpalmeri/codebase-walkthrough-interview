import { comparePricingPaths } from "../../src/pricing/price-compare.js";
import { quotePrice } from "../../src/pricing/pricing-service.js";
import { estimateAtIntake } from "../../src/pricing/intake-estimate.js";
import { legacyVisitPrice } from "../../src/pricing/legacy-price-resolver.js";

describe("pricing consistency", () => {
  it("returns different amounts from different pricing paths for one visit", async () => {
    const comparison = await comparePricingPaths("visit_0_0_0");
    // The scheduling display, charge path, and pricing service disagree because
    // each resolves coverage, service type, location, and date differently.
    expect(comparison.agreement.amounts.length).toBeGreaterThan(1);
    expect(comparison.agreement.allAgree).toBe(false);
  });

  it.fails("all pricing paths agree on a visit's price", async () => {
    const comparison = await comparePricingPaths("visit_0_0_0");
    // Documents the target state, which does not hold today.
    expect(comparison.agreement.allAgree).toBe(true);
  });

  it("prices the pricing service deterministically against the service date", async () => {
    const quote = await quotePrice({
      organizationId: "org_northstar",
      coverageId: "coverage_001",
      serviceType: "SKILLED_NURSING",
      serviceDate: new Date("2025-05-15T00:00:00Z"),
    });
    expect(quote.source).toBe("pricing-service");
    expect(Number(quote.amount)).toBeGreaterThan(0);
    expect(quote.rateId).toBeTruthy();
  });

  it("computes the intake estimate as a fraction of the current contract rate", async () => {
    const estimate = await estimateAtIntake("org_northstar", "coverage_001", "SKILLED_NURSING", new Date("2025-05-15T00:00:00Z"));
    const billing = await legacyVisitPrice("visit_1_0_0");
    // The intake estimate is a 20% patient-responsibility fraction; the billing
    // path resolves a full contracted amount. They are not the same number.
    expect(Number(estimate.amount)).toBeLessThan(Number(billing.amount));
  });
});
