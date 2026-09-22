import {
  IssueTenantApiKeyRequestSchema,
  IssueTenantApiKeyResponseSchema,
  RevokeTenantApiKeyRequestSchema,
  RevokeTenantApiKeyResponseSchema,
} from "@meridian/contracts";
import { ADMIN_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as tenantApiKeys from "../controllers/tenantApiKeyController";
import { defineOperation, IdempotencyRequestHeadersSchema, mountOperation } from "../openapi/operation";
import { Router, type Request } from "express";
import { z } from "zod";

const OneTimeCredentialResponseHeadersSchema = z.object({
  "Cache-Control": z.literal("no-store"),
  Pragma: z.literal("no-cache"),
});

function apiKeyPepper(request: Request): string {
  const configured = request.app.locals.meridianApiKeyPepper;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error("MERIDIAN_API_KEY_PEPPER is required for tenant API-key administration");
  }
  return configured;
}

const issueTenantApiKeyOperation = defineOperation({
  method: "post",
  path: "/tenant-api-keys",
  operationId: "issueTenantApiKey",
  summary: "Issue a tenant API key",
  description:
    "Requires an active ADMIN tenant API key. The plaintext token is returned exactly once and Idempotency-Key is deliberately unsupported.",
  request: IssueTenantApiKeyRequestSchema,
  hasJsonBody: true,
  success: { status: 201, description: "Issued tenant API key and one-time token", schema: IssueTenantApiKeyResponseSchema },
  security: "tenantBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 409, 500],
  responseHeaders: OneTimeCredentialResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    // Tokens are credentials, not a representation that intermediaries may retain.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    return tenantApiKeys.issueTenantApiKey(principal, input.body, requestAuditMetadata(request, principal), apiKeyPepper(request));
  },
});

const revokeTenantApiKeyOperation = defineOperation({
  method: "post",
  path: "/tenant-api-keys/revoke",
  operationId: "revokeTenantApiKey",
  summary: "Revoke a tenant API key",
  description: "Requires an active ADMIN tenant API key. Revocation is tenant-scoped and monotonic.",
  request: RevokeTenantApiKeyRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Tenant API key revocation result", schema: RevokeTenantApiKeyResponseSchema },
  security: "tenantBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 404, 409, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    tenantApiKeys.revokeTenantApiKey(principal, input.body, requestAuditMetadata(request, principal)),
});

export const tenantApiKeyOperations = [issueTenantApiKeyOperation, revokeTenantApiKeyOperation] as const;

export const tenantApiKeysView = Router();
for (const operation of tenantApiKeyOperations) mountOperation(tenantApiKeysView, operation);
