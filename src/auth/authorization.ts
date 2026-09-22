import type { Request } from "express";
import { AuthenticationError, AuthorizationError } from "../errors";
import { PrincipalRoleSchema, PrincipalSchema, type Principal } from "./principal";

export const READ_ROLES = PrincipalRoleSchema.options;
export const BILLING_WRITE_ROLES = ["ADMIN", "BILLING"] as const;
export const ADMIN_ROLES = ["ADMIN"] as const;

type PrincipalRequest = Pick<Request, "principal">;

export function requirePrincipal(request: PrincipalRequest): Principal {
  const principal = PrincipalSchema.safeParse(request.principal);
  if (!principal.success) throw new AuthenticationError();
  return principal.data;
}

export function requireRole(
  request: PrincipalRequest,
  allowedRoles: readonly Principal["role"][]
): Principal {
  const principal = requirePrincipal(request);
  if (!allowedRoles.includes(principal.role)) throw new AuthorizationError();
  return principal;
}
