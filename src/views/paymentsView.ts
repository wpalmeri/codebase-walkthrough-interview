import {
  ApplyPaymentRequestSchema,
  GetPaymentRequestSchema,
  ListPaymentsRequestSchema,
  ListPaymentsV1RequestSchema,
  PaymentApplicationReversalSchema,
  PaymentPageSchema,
  PaymentSchema,
  RecordPaymentRequestSchema,
  ReversePaymentApplicationRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { z } from "zod";
import { BILLING_WRITE_ROLES, READ_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as payments from "../controllers/paymentController";
import { isV1Request } from "../http/apiVersion";
import { formatNextPageLink } from "../http/pagination";
import {
  IdempotencyRequestHeadersSchema,
  PaginationResponseHeadersSchema,
  defineOperation,
  mountOperation,
} from "../openapi/operation";
import { RequestValidationError, validateRequest } from "./helpers";

// The mounted legacy adapter deliberately remains an array while `/api/v1`
// returns the additive page envelope. One operation retains runtime validation
// for both representations; generated OpenAPI is consumed only as the v1 API.
const PaymentListResponseSchema = z.union([PaymentSchema.array(), PaymentPageSchema]);

const listPaymentsOperation = defineOperation({
  method: "get",
  path: "/payments",
  operationId: "listPayments",
  summary: "List payments",
  description:
    "`/api/v1` returns cursor-paginated payments ordered by receivedAt then id; the legacy `/api` adapter remains a first-100 array.",
  request: ListPaymentsV1RequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Cursor-paginated payment page",
    schema: PaymentListResponseSchema,
    openApiSchema: PaymentPageSchema,
  },
  security: "operatorBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  responseHeaders: PaginationResponseHeadersSchema,
  handler: async ({ input, request, response }) => {
    if (!isV1Request(request)) {
      // ListPaymentsV1RequestSchema is the v1 public contract. Re-validate
      // the raw legacy request so query pagination remains an additive v1-only
      // capability instead of silently changing `/api` behavior.
      validateRequest(ListPaymentsRequestSchema, request);
      return payments.listPayments();
    }

    const page = await payments.listPaymentsPage(input.query);
    if (!page.ok) {
      throw new RequestValidationError([
        {
          code: page.code,
          path: "query.cursor",
          message: "Cursor is invalid for this payment query",
        },
      ]);
    }
    const link = formatNextPageLink(request.originalUrl, page.page.page.nextCursor);
    if (link !== undefined) response.append("Link", link);
    return page.page;
  },
});

const getPaymentOperation = defineOperation({
  method: "get",
  path: "/payments/:id",
  operationId: "getPayment",
  summary: "Get a payment",
  request: GetPaymentRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Payment representation", schema: PaymentSchema },
  security: "operatorBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 404, 500],
  handler: async ({ input }) => payments.getPayment(input.params.id),
});

const recordPaymentOperation = defineOperation({
  method: "post",
  path: "/payments",
  operationId: "recordPayment",
  summary: "Record a payment receipt",
  request: RecordPaymentRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Recorded payment", schema: PaymentSchema },
  security: "operatorBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    payments.recordPayment(input.body, {
      metadata: requestAuditMetadata(request, principal),
    }),
});

const reversePaymentApplicationOperation = defineOperation({
  method: "post",
  path: "/payments/:id/applications/:applicationId/reversals",
  operationId: "reversePaymentApplication",
  summary: "Reverse an applied payment amount",
  request: ReversePaymentApplicationRequestSchema,
  hasJsonBody: true,
  success: {
    status: 201,
    description: "Created payment-application reversal",
    schema: PaymentApplicationReversalSchema,
  },
  security: "operatorBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    payments.reversePaymentApplication(
      input.params.id,
      input.params.applicationId,
      input.body,
      { metadata: requestAuditMetadata(request, principal) }
    ),
});

const applyPaymentOperation = defineOperation({
  method: "post",
  path: "/payments/:id/apply",
  operationId: "applyPayment",
  summary: "Apply a payment across invoices",
  request: ApplyPaymentRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Payment with current applications", schema: PaymentSchema },
  security: "operatorBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    payments.applyPayment(input.params.id, input.body.applications, {
      metadata: requestAuditMetadata(request, principal),
    }),
});

/** Reused by the OpenAPI inventory; these descriptors are what Express mounts. */
export const paymentOperations = [
  listPaymentsOperation,
  getPaymentOperation,
  recordPaymentOperation,
  reversePaymentApplicationOperation,
  applyPaymentOperation,
] as const;

export const paymentsView = Router();
for (const operation of paymentOperations) mountOperation(paymentsView, operation);
