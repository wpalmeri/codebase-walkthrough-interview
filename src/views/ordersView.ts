import {
  CreateInvoiceForOrderRequestSchema,
  CreateOrderRequestSchema,
  GetOrderRequestSchema,
  InvoiceSchema,
  ListOrdersRequestSchema,
  ListOrdersV1RequestSchema,
  OrderConditionalRequestHeadersSchema,
  OrderPageSchema,
  OrderSchema,
  UpdateOrderRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { z } from "zod";
import { BILLING_WRITE_ROLES, READ_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as invoices from "../controllers/invoiceController";
import * as orders from "../controllers/orderController";
import { isV1Request } from "../http/apiVersion";
import { formatNextPageLink } from "../http/pagination";
import {
  EtagResponseHeadersSchema,
  IdempotencyRequestHeadersSchema,
  PaginationResponseHeadersSchema,
  defineOperation,
  mountOperation,
} from "../openapi/operation";
import { RequestValidationError, validateRequest } from "./helpers";

const OrderListResponseSchema = z.union([OrderSchema.array(), OrderPageSchema]);

const listOrdersOperation = defineOperation({
  method: "get",
  path: "/orders",
  operationId: "listOrders",
  summary: "List orders",
  description:
    "`/api/v1` returns cursor-paginated orders ordered by orderDate then id, both descending; the legacy `/api` adapter remains an array.",
  request: ListOrdersV1RequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Cursor-paginated order page",
    schema: OrderListResponseSchema,
    openApiSchema: OrderPageSchema,
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  responseHeaders: PaginationResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    if (!isV1Request(request)) {
      validateRequest(ListOrdersRequestSchema, request);
      return orders.listOrders(principal.tenantId);
    }

    const page = await orders.listOrdersPage(principal.tenantId, input.query);
    if (!page.ok) {
      throw new RequestValidationError([
        {
          code: page.code,
          path: "query.cursor",
          message: "Cursor is invalid for this order query",
        },
      ]);
    }
    const link = formatNextPageLink(request.originalUrl, page.page.page.nextCursor);
    if (link !== undefined) response.append("Link", link);
    return page.page;
  },
});

const getOrderOperation = defineOperation({
  method: "get",
  path: "/orders/:id",
  operationId: "getOrder",
  summary: "Get an order",
  description: "On `/api/v1`, returns a strong ETag for conditional updates.",
  request: GetOrderRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Order representation", schema: OrderSchema },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 404, 500],
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    const result = await orders.getVersionedOrder(principal.tenantId, input.params.id);
    if (isV1Request(request)) response.setHeader("ETag", result.etag);
    return result.order;
  },
});

const createOrderOperation = defineOperation({
  method: "post",
  path: "/orders",
  operationId: "createOrder",
  summary: "Create an order with materialized pricing",
  request: CreateOrderRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Created order", schema: OrderSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    orders.createOrder(principal.tenantId, input.body, requestAuditMetadata(request, principal)),
});

const updateOrderOperation = defineOperation({
  method: "put",
  path: "/orders/:id",
  operationId: "replaceOrder",
  summary: "Update an order",
  description:
    "Deprecated: this historical partial-update PUT remains supported for existing clients. Use PATCH `/orders/{id}` for all new partial updates. `/api/v1` requires an exact strong If-Match ETag and returns the next ETag; legacy `/api` keeps its unconditional update behavior.",
  deprecated: true,
  request: UpdateOrderRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Updated order", schema: OrderSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 422, 428, 500],
  requestHeaders: IdempotencyRequestHeadersSchema.merge(OrderConditionalRequestHeadersSchema),
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    const audit = requestAuditMetadata(request, principal);
    if (!isV1Request(request)) return orders.saveOrder(principal.tenantId, input.params.id, input.body, audit);

    const result = await orders.saveOrderConditionally(
      principal.tenantId,
      input.params.id,
      input.body,
      request.get("if-match"),
      audit
    );
    response.setHeader("ETag", result.etag);
    return result.order;
  },
});

const patchOrderOperation = defineOperation({
  method: "patch",
  path: "/orders/:id",
  operationId: "updateOrder",
  summary: "Partially update an order",
  description:
    "`/api/v1` requires an exact strong If-Match ETag and returns the next ETag; legacy `/api` keeps its unconditional update behavior.",
  request: UpdateOrderRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Updated order", schema: OrderSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 422, 428, 500],
  requestHeaders: IdempotencyRequestHeadersSchema.merge(OrderConditionalRequestHeadersSchema),
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    const audit = requestAuditMetadata(request, principal);
    if (!isV1Request(request)) return orders.saveOrder(principal.tenantId, input.params.id, input.body, audit);

    const result = await orders.saveOrderConditionally(
      principal.tenantId,
      input.params.id,
      input.body,
      request.get("if-match"),
      audit
    );
    response.setHeader("ETag", result.etag);
    return result.order;
  },
});

const createInvoiceForOrderOperation = defineOperation({
  method: "post",
  path: "/orders/:id/invoice",
  operationId: "createInvoiceForOrder",
  summary: "Create an invoice from a materialized order",
  request: CreateInvoiceForOrderRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Created draft invoice", schema: InvoiceSchema },
  security: "tenantBearer",
  roles: BILLING_WRITE_ROLES,
  errors: [400, 401, 403, 404, 409, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    invoices.createInvoiceForOrder(principal.tenantId, input.params.id, {
      metadata: requestAuditMetadata(request, principal),
    }),
});

/** Reused by the OpenAPI inventory; these descriptors are what Express mounts. */
export const orderOperations = [
  listOrdersOperation,
  getOrderOperation,
  createOrderOperation,
  updateOrderOperation,
  patchOrderOperation,
  createInvoiceForOrderOperation,
] as const;

export const ordersView = Router();
for (const operation of orderOperations) mountOperation(ordersView, operation);
