import {
  CloseAccountingPeriodRequestSchema,
  CloseAccountingPeriodResponseSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { ADMIN_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as accountingPeriods from "../controllers/accountingPeriodCloseController";
import { defineOperation, IdempotencyRequestHeadersSchema, mountOperation } from "../openapi/operation";

const closeAccountingPeriodOperation = defineOperation({
  method: "post",
  path: "/accounting-periods/close",
  operationId: "closeAccountingPeriod",
  summary: "Close a tenant accounting period",
  description: "Requires an active ADMIN tenant API key. The inclusive close date may only advance and every actual transition is audited.",
  request: CloseAccountingPeriodRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Accounting-period close result", schema: CloseAccountingPeriodResponseSchema },
  security: "tenantBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    accountingPeriods.closeAccountingPeriodForRequest(principal, input.body, requestAuditMetadata(request, principal)),
});

export const accountingPeriodOperations = [closeAccountingPeriodOperation] as const;

export const accountingPeriodsView = Router();
for (const operation of accountingPeriodOperations) mountOperation(accountingPeriodsView, operation);
