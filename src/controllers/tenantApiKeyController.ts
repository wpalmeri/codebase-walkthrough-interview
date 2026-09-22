import {
  IssueTenantApiKeyResponseSchema,
  RevokeTenantApiKeyResponseSchema,
  type IssueTenantApiKeyResponse,
  type RevokeTenantApiKeyResponse,
} from "@meridian/contracts";
import { prisma } from "../db";
import { AuthorizationError, ConflictError, NotFoundError } from "../errors";
import type { Principal } from "../auth/principal";
import {
  TenantApiKeyAdministrationError,
  type TenantApiKeyAdministrationStore,
  type TenantApiKeyAdministrationTransaction,
  issueTenantApiKeyForAdmin,
  revokeTenantApiKeyForAdmin,
} from "../auth/tenantApiKeyLifecycle";
import type { RequestAuditMetadata } from "../audit/requestAudit";

// Prisma intentionally hides a few client-level methods from interactive
// transactions. Keep that implementation detail at this adapter boundary.
const administrationStore: TenantApiKeyAdministrationStore = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Prisma omits client-only methods from this transaction type; the lifecycle interface exposes only delegates present on both.
  $transaction: (operation) => prisma.$transaction((transaction) => operation(transaction as unknown as TenantApiKeyAdministrationTransaction)),
};

function mapLifecycleError(error: unknown): never {
  if (!(error instanceof TenantApiKeyAdministrationError)) throw error;
  switch (error.code) {
    case "ADMIN_API_KEY_REQUIRED":
    case "ACTING_KEY_NOT_ACTIVE":
    case "AUDIT_IDENTITY_MISMATCH":
      throw new AuthorizationError();
    case "KEY_NAME_CONFLICT":
      throw new ConflictError("TENANT_API_KEY_NAME_CONFLICT", "A tenant API key already uses this name");
    case "KEY_NOT_FOUND":
      // Deliberately identical for an absent key and a key belonging to a different tenant.
      throw new NotFoundError("TENANT_API_KEY_NOT_FOUND", "Tenant API key was not found");
    case "KEY_PREFIX_COLLISION":
      throw new ConflictError("TENANT_API_KEY_PREFIX_COLLISION", "Could not allocate a unique tenant API key");
    case "SELF_REVOCATION_NOT_ALLOWED":
      throw new ConflictError("TENANT_API_KEY_SELF_REVOCATION", "The credential authorizing this request cannot revoke itself");
    case "LAST_ACTIVE_ADMIN_REQUIRED":
      throw new ConflictError("TENANT_API_KEY_LAST_ADMIN", "A tenant must retain at least one active administrator credential");
  }
}

export async function issueTenantApiKey(
  principal: Principal,
  body: unknown,
  metadata: RequestAuditMetadata,
  pepper: string
): Promise<IssueTenantApiKeyResponse> {
  try {
    const issued = await issueTenantApiKeyForAdmin(administrationStore, principal, body, metadata, pepper);
    return IssueTenantApiKeyResponseSchema.parse({
      key: {
        id: issued.id,
        name: issued.name,
        role: issued.role,
        keyPrefix: issued.keyPrefix,
        createdAt: issued.createdAt.toISOString(),
      },
      token: issued.token,
    });
  } catch (error) {
    return mapLifecycleError(error);
  }
}

export async function revokeTenantApiKey(
  principal: Principal,
  body: unknown,
  metadata: RequestAuditMetadata
): Promise<RevokeTenantApiKeyResponse> {
  try {
    const revoked = await revokeTenantApiKeyForAdmin(administrationStore, principal, body, metadata);
    return RevokeTenantApiKeyResponseSchema.parse({
      key: {
        id: revoked.id,
        keyPrefix: revoked.keyPrefix,
        state: revoked.state,
        revokedAt: revoked.revokedAt.toISOString(),
      },
    });
  } catch (error) {
    return mapLifecycleError(error);
  }
}
