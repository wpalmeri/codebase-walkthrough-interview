/**
 * The immutable identity used when the bounded migration assigns pre-tenancy
 * records. Runtime principals and seeds may import this module without pulling
 * database clients or migration job code into their dependency graph.
 */
export const LEGACY_DEFAULT_TENANT_ID = "legacy-default";
export const LEGACY_DEFAULT_TENANT_SLUG = "legacy-default";
export const LEGACY_DEFAULT_TENANT_NAME = "Legacy default tenant";
