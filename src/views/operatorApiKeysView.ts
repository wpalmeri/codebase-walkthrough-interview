import {
  IssueOperatorApiKeyRequestSchema,
  IssueOperatorApiKeyResponseSchema,
  RevokeOperatorApiKeyRequestSchema,
  RevokeOperatorApiKeyResponseSchema,
} from "@meridian/contracts";
import { Router, type Request } from "express";
import { z } from "zod";
import { ADMIN_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as operatorApiKeys from "../controllers/operatorApiKeyController";
import { defineOperation, IdempotencyRequestHeadersSchema, mountOperation } from "../openapi/operation";

const OneTimeCredentialResponseHeadersSchema = z.object({ "Cache-Control": z.literal("no-store"), Pragma: z.literal("no-cache") });

function apiKeyPepper(request: Request): string {
  const configured = request.app.locals.meridianApiKeyPepper;
  if (typeof configured !== "string" || configured.length === 0) throw new Error("MERIDIAN_API_KEY_PEPPER is required for operator API-key administration");
  return configured;
}

const issueOperatorApiKeyOperation = defineOperation({
  method: "post",
  path: "/operator-api-keys",
  operationId: "issueOperatorApiKey",
  summary: "Issue an operator API key",
  description: "Requires an active ADMIN operator API key. The plaintext token is returned exactly once and Idempotency-Key is unsupported.",
  request: IssueOperatorApiKeyRequestSchema,
  hasJsonBody: true,
  success: { status: 201, description: "Issued operator API key and one-time token", schema: IssueOperatorApiKeyResponseSchema },
  security: "operatorBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 409, 500],
  responseHeaders: OneTimeCredentialResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    return operatorApiKeys.issueOperatorApiKey(principal, input.body, requestAuditMetadata(request, principal), apiKeyPepper(request));
  },
});

const revokeOperatorApiKeyOperation = defineOperation({
  method: "post",
  path: "/operator-api-keys/revoke",
  operationId: "revokeOperatorApiKey",
  summary: "Revoke an operator API key",
  description: "Requires an active ADMIN operator API key. Revocation is monotonic.",
  request: RevokeOperatorApiKeyRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Operator API key revocation result", schema: RevokeOperatorApiKeyResponseSchema },
  security: "operatorBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 404, 409, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) => operatorApiKeys.revokeOperatorApiKey(principal, input.body, requestAuditMetadata(request, principal)),
});

export const operatorApiKeyOperations = [issueOperatorApiKeyOperation, revokeOperatorApiKeyOperation] as const;
export const operatorApiKeysView = Router();
for (const operation of operatorApiKeyOperations) mountOperation(operatorApiKeysView, operation);
