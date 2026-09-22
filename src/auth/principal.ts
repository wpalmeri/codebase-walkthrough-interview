import { z } from "zod";

/**
 * The server-derived identity used to scope every protected request. Even the
 * temporary legacy/development bridge belongs to legacy-default so protected
 * operations never become unscoped by accident.
 */
export const TenantIdSchema = z.string().min(1).max(191);
export const PrincipalKindSchema = z.enum(["TENANT_API_KEY", "LEGACY_API_KEY", "DEVELOPMENT"]);
export const PrincipalRoleSchema = z.enum(["ADMIN", "BILLING", "VIEWER"]);

export const PrincipalSchema = z
  .object({
    tenantId: TenantIdSchema,
    subjectId: z.string().min(1).max(191),
    credentialId: z.string().min(1).max(191),
    kind: PrincipalKindSchema,
    role: PrincipalRoleSchema,
  })
  .strict();

export type Principal = z.infer<typeof PrincipalSchema>;

declare global {
  namespace Express {
    interface Request {
      /** Set only by the authentication boundary; never read from client input. */
      principal?: Principal;
    }
  }
}
