import {
  GetInvoiceRequestSchema,
  InvoicePageSchema,
  InvoiceSchema,
  ListInvoicesRequestSchema,
  ListInvoicesV1RequestSchema,
  PostInvoiceRequestSchema,
  RefreshTransmissionRequestSchema,
  SendInvoiceRequestSchema,
  TransmissionSchema,
  UpdateInvoiceRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { z } from "zod";
import { BILLING_WRITE_ROLES, READ_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as invoices from "../controllers/invoiceController";
import { isV1Request } from "../http/apiVersion";
import { formatNextPageLink } from "../http/pagination";
import {
  EtagResponseHeadersSchema,
  IdempotencyRequestHeadersSchema,
  PaginationResponseHeadersSchema,
  RateConditionalRequestHeadersSchema,
  defineOperation,
  mountOperation,
} from "../openapi/operation";
import { RequestValidationError, validateRequest } from "./helpers";

// The header syntax is identical for every versioned resource ETag. Keep the
// invoice name at this boundary while reusing the committed shared schema.
const InvoiceConditionalRequestHeadersSchema = RateConditionalRequestHeadersSchema;
const InvoiceListResponseSchema = z.union([InvoiceSchema.array(), InvoicePageSchema]);

const listInvoicesOperation = defineOperation({
  method: "get",
  path: "/invoices",
  operationId: "listInvoices",
  summary: "List invoices",
  request: ListInvoicesV1RequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Cursor-paginated invoice page",
    schema: InvoiceListResponseSchema,
    openApiSchema: InvoicePageSchema,
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  responseHeaders: PaginationResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    if (!isV1Request(request)) {
      validateRequest(ListInvoicesRequestSchema, request);
      return invoices.listInvoices(principal.tenantId);
    }

    const page = await invoices.listInvoicesPage(principal.tenantId, input.query);
    if (!page.ok) {
      throw new RequestValidationError([
        {
          code: page.code,
          path: "query.cursor",
          message: "Cursor is invalid for this invoice query",
        },
      ]);
    }
    const link = formatNextPageLink(request.originalUrl, page.page.page.nextCursor);
    if (link !== undefined) response.append("Link", link);
    return page.page;
  },
});

const getInvoiceOperation = defineOperation({
  method: "get",
  path: "/invoices/:id",
  operationId: "getInvoice",
  summary: "Get an invoice",
  description: "On `/api/v1`, returns a strong ETag for conditional updates.",
  request: GetInvoiceRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Invoice representation", schema: InvoiceSchema },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 404, 500],
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    const result = await invoices.getVersionedInvoice(principal.tenantId, input.params.id);
    if (isV1Request(request)) response.setHeader("ETag", result.etag);
    return result.invoice;
  },
});

function updateInvoiceOperation(
  method: "put" | "patch",
  operationId: string,
  summary: string,
  deprecated = false
) {
  return defineOperation({
    method,
    path: "/invoices/:id",
    operationId,
    summary,
    description: deprecated
      ? "Deprecated: this historical partial-update PUT remains supported for existing clients. Use PATCH `/invoices/{id}` for all new partial date updates. `/api/v1` requires an exact strong If-Match ETag and returns the next ETag."
      : "Partially updates invoice dates. `/api/v1` requires an exact strong If-Match ETag and returns the next ETag.",
    deprecated,
    request: UpdateInvoiceRequestSchema,
    hasJsonBody: true,
    success: { status: 200, description: "Updated invoice", schema: InvoiceSchema },
    security: "tenantBearer",
    roles: BILLING_WRITE_ROLES,
    errors: [400, 401, 403, 404, 409, 412, 422, 428, 500],
    requestHeaders: IdempotencyRequestHeadersSchema.merge(InvoiceConditionalRequestHeadersSchema),
    responseHeaders: EtagResponseHeadersSchema,
    handler: async ({ input, principal, request, response }) => {
      const audit = { metadata: requestAuditMetadata(request, principal) };
      if (!isV1Request(request)) return invoices.updateInvoice(principal.tenantId, input.params.id, input.body, audit);
      const result = await invoices.updateInvoiceConditionally(
        principal.tenantId,
        input.params.id,
        input.body,
        request.get("if-match"),
        audit
      );
      response.setHeader("ETag", result.etag);
      return result.invoice;
    },
  });
}

const replaceInvoiceOperation = updateInvoiceOperation("put", "replaceInvoice", "Replace invoice dates", true);
const updateInvoiceOperationDescriptor = updateInvoiceOperation("patch", "updateInvoice", "Partially update invoice dates");

const postInvoiceOperation = defineOperation({
  method: "post",
  path: "/invoices/:id/post",
  operationId: "postInvoice",
  summary: "Post a draft invoice",
  request: PostInvoiceRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Posted invoice", schema: InvoiceSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    invoices.postInvoice(principal.tenantId, input.params.id, {
      metadata: requestAuditMetadata(request, principal),
    }),
});

const sendInvoiceOperation = defineOperation({
  method: "post",
  path: "/invoices/:id/send",
  operationId: "sendInvoice",
  summary: "Send an invoice through a delivery method",
  request: SendInvoiceRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Invoice after delivery attempt", schema: InvoiceSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    invoices.sendInvoice(principal.tenantId, input.params.id, input.body.method, {
      metadata: requestAuditMetadata(request, principal),
    }),
});

const refreshTransmissionOperation = defineOperation({
  method: "post",
  path: "/invoices/transmissions/:transmissionId/refresh",
  operationId: "refreshInvoiceTransmission",
  summary: "Refresh an invoice transmission",
  request: RefreshTransmissionRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Refreshed transmission", schema: TransmissionSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    invoices.refreshTransmission(principal.tenantId, input.params.transmissionId, {
      metadata: requestAuditMetadata(request, principal),
    }),
});

/** Reused by the OpenAPI inventory; these descriptors are what Express mounts. */
export const invoiceOperations = [
  listInvoicesOperation,
  getInvoiceOperation,
  replaceInvoiceOperation,
  updateInvoiceOperationDescriptor,
  postInvoiceOperation,
  sendInvoiceOperation,
  refreshTransmissionOperation,
] as const;

export const invoicesView = Router();
for (const operation of invoiceOperations) mountOperation(invoicesView, operation);
