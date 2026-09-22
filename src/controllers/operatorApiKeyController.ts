import {
  IssueOperatorApiKeyResponseSchema,
  RevokeOperatorApiKeyResponseSchema,
  type IssueOperatorApiKeyResponse,
  type RevokeOperatorApiKeyResponse,
} from "@meridian/contracts";
import { prisma } from "../db";
import { AuthorizationError, ConflictError, NotFoundError } from "../errors";
import type { Principal } from "../auth/principal";
import {
  OperatorApiKeyAdministrationError,
  type OperatorApiKeyAdministrationStore,
  type OperatorApiKeyAdministrationTransaction,
  issueOperatorApiKeyForAdmin,
  revokeOperatorApiKeyForAdmin,
} from "../auth/operatorApiKeyLifecycle";
import type { RequestAuditMetadata } from "../audit/requestAudit";

const administrationStore: OperatorApiKeyAdministrationStore = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Prisma omits client-only methods from interactive transactions.
  $transaction: (operation) => prisma.$transaction((transaction) => operation(transaction as unknown as OperatorApiKeyAdministrationTransaction)),
};

function mapLifecycleError(error: unknown): never {
  if (!(error instanceof OperatorApiKeyAdministrationError)) throw error;
  switch (error.code) {
    case "ADMIN_API_KEY_REQUIRED":
    case "ACTING_KEY_NOT_ACTIVE":
    case "AUDIT_IDENTITY_MISMATCH":
      throw new AuthorizationError();
    case "KEY_NAME_CONFLICT":
      throw new ConflictError("OPERATOR_API_KEY_NAME_CONFLICT", "An operator API key already uses this name");
    case "KEY_NOT_FOUND":
      throw new NotFoundError("OPERATOR_API_KEY_NOT_FOUND", "Operator API key was not found");
    case "KEY_PREFIX_COLLISION":
      throw new ConflictError("OPERATOR_API_KEY_PREFIX_COLLISION", "Could not allocate a unique operator API key");
    case "SELF_REVOCATION_NOT_ALLOWED":
      throw new ConflictError("OPERATOR_API_KEY_SELF_REVOCATION", "The credential authorizing this request cannot revoke itself");
    case "LAST_ACTIVE_ADMIN_REQUIRED":
      throw new ConflictError("OPERATOR_API_KEY_LAST_ADMIN", "The system must retain at least one active administrator credential");
  }
}

export async function issueOperatorApiKey(
  principal: Principal,
  body: unknown,
  metadata: RequestAuditMetadata,
  pepper: string
): Promise<IssueOperatorApiKeyResponse> {
  try {
    const issued = await issueOperatorApiKeyForAdmin(administrationStore, principal, body, metadata, pepper);
    return IssueOperatorApiKeyResponseSchema.parse({
      key: { id: issued.id, name: issued.name, role: issued.role, keyPrefix: issued.keyPrefix, createdAt: issued.createdAt.toISOString() },
      token: issued.token,
    });
  } catch (error) {
    return mapLifecycleError(error);
  }
}

export async function revokeOperatorApiKey(
  principal: Principal,
  body: unknown,
  metadata: RequestAuditMetadata
): Promise<RevokeOperatorApiKeyResponse> {
  try {
    const revoked = await revokeOperatorApiKeyForAdmin(administrationStore, principal, body, metadata);
    return RevokeOperatorApiKeyResponseSchema.parse({
      key: { id: revoked.id, keyPrefix: revoked.keyPrefix, state: revoked.state, revokedAt: revoked.revokedAt.toISOString() },
    });
  } catch (error) {
    return mapLifecycleError(error);
  }
}
