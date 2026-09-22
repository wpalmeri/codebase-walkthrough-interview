import {
  CreateInvoiceForOrderRequestSchema,
  CreateOrderRequestSchema,
  GetOrderRequestSchema,
  InvoiceSchema,
  ListOrdersRequestSchema,
  OrderConditionalRequestHeadersSchema,
  OrderSchema,
  UpdateOrderRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { BILLING_WRITE_ROLES, READ_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as invoices from "../controllers/invoiceController";
import * as orders from "../controllers/orderController";
import { isV1Request } from "../http/apiVersion";
import {
  EtagResponseHeadersSchema,
  IdempotencyRequestHeadersSchema,
  defineOperation,
  mountOperation,
} from "../openapi/operation";

const listOrdersOperation = defineOperation({
  method: "get",
  path: "/orders",
  operationId: "listOrders",
  summary: "List orders",
  request: ListOrdersRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Orders visible to the tenant", schema: OrderSchema.array() },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 403, 500],
  handler: async ({ principal }) => orders.listOrders(principal.tenantId),
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
