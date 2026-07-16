// Per-customer behavior that accumulated in shared code paths over time.
// Sales has promised several of these "temporarily" — see the enterprise
// onboarding notes in docs/product-notes/enterprise-requirements.md.

export const EVERGREEN_SLUG = "evergreen-behavioral";
export const NORTHSTAR_SLUG = "northstar-home-health";
export const LAKESIDE_SLUG = "lakeside-care";

// Evergreen signed before documentation gating existed; billing agreed to
// let their claims go out with unsigned notes "until Q3".
export function allowsBillingWithoutSignedNote(organizationSlug: string): boolean {
  return organizationSlug === EVERGREEN_SLUG;
}

// Lakeside statements are mailed by a third party that requires the 2019
// statement layout with amounts in whole dollars.
export function usesLegacyStatementFormat(organizationSlug: string): boolean {
  return organizationSlug === LAKESIDE_SLUG;
}

// Evergreen's controller wants claim aging bucketed weekly instead of 30/60/90.
export function usesWeeklyAgingBuckets(organizationSlug: string): boolean {
  return organizationSlug === EVERGREEN_SLUG;
}

// Custom columns Evergreen asked for in every visit export. These are joined
// per-row in reporting/custom-report.ts.
export function extraExportColumns(organizationSlug: string): string[] {
  if (organizationSlug === EVERGREEN_SLUG) return ["referral_source", "region_name", "auth_number"];
  if (organizationSlug === NORTHSTAR_SLUG) return ["auth_number"];
  return [];
}

// Evergreen was promised that cancelled visits still count against
// authorization limits (their payer counts them). Everyone else excludes them.
export function countsCancelledVisitsAgainstAuth(organizationSlug: string): boolean {
  return organizationSlug === EVERGREEN_SLUG;
}

// One-off pilot: Lakeside gets the new pricing service for charge creation.
export function usesPricingServiceForCharges(organizationSlug: string): boolean {
  return organizationSlug === LAKESIDE_SLUG;
}
