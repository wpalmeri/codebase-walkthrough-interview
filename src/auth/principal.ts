import { z } from "zod";

/**
 * The server-derived identity for a protected request. Meridian has one
 * company-owned billing database: callers never select a customer or data
 * scope through authentication headers or request data.
 */
export const PrincipalKindSchema = z.enum(["OPERATOR_API_KEY", "LEGACY_API_KEY", "DEVELOPMENT"]);
export const PrincipalRoleSchema = z.enum(["ADMIN", "BILLING", "VIEWER"]);

export const PrincipalSchema = z
  .object({
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
