import {
  ComboDiscountSchema,
  CreateComboDiscountRequestSchema,
  GetRateRequestSchema,
  ListComboDiscountsRequestSchema,
  ListRatesRequestSchema,
  RateSchema,
  UpdateRateRequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { ADMIN_ROLES, READ_ROLES } from "../auth/authorization";
import { requestAuditMetadata } from "../audit/requestAudit";
import * as rates from "../controllers/rateController";
import { isV1Request } from "../http/apiVersion";
import {
  EtagResponseHeadersSchema,
  IdempotencyRequestHeadersSchema,
  RateConditionalRequestHeadersSchema,
  defineOperation,
  mountOperation,
} from "../openapi/operation";

const listRatesOperation = defineOperation({
  method: "get",
  path: "/rates",
  operationId: "listRates",
  summary: "List customer-specific rates",
  request: ListRatesRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Customer-specific rates", schema: RateSchema.array() },
  security: "operatorBearer",
  roles: READ_ROLES,
  errors: [400, 401, 404, 500],
  handler: async ({ input }) => rates.listRates(input.query.customerId),
});

const listComboDiscountsOperation = defineOperation({
  method: "get",
  path: "/rates/combos",
  operationId: "listComboDiscounts",
  summary: "List combo discounts",
  request: ListComboDiscountsRequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Customer-specific and global combo discounts",
    schema: ComboDiscountSchema.array(),
  },
  security: "operatorBearer",
  roles: READ_ROLES,
  errors: [400, 401, 404, 500],
  handler: async ({ input }) => rates.listComboDiscounts(input.query.customerId),
});

const createComboDiscountOperation = defineOperation({
  method: "post",
  path: "/rates/combos",
  operationId: "createComboDiscount",
  summary: "Create a combo discount",
  request: CreateComboDiscountRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Created combo discount", schema: ComboDiscountSchema },
  security: "operatorBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 404, 409, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    rates.createComboDiscount({
      ...input.body,
      customerId: input.body.customerId ?? null,
    }, { metadata: requestAuditMetadata(request, principal) }),
});

const getRateOperation = defineOperation({
  method: "get",
  path: "/rates/:id",
  operationId: "getRate",
  summary: "Get a rate",
  description: "On `/api/v1`, returns a strong ETag for conditional updates.",
  request: GetRateRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Rate representation", schema: RateSchema },
  security: "operatorBearer",
  roles: READ_ROLES,
  errors: [400, 401, 404, 500],
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, request, response }) => {
    const result = await rates.getVersionedRate(input.params.id);
    if (isV1Request(request)) response.setHeader("ETag", result.etag);
    return result.rate;
  },
});

function updateRateOperation(
  method: "put" | "patch",
  operationId: string,
  summary: string,
  deprecated = false
) {
  return defineOperation({
    method,
    path: "/rates/:id",
    operationId,
    summary,
    description: deprecated
      ? "Deprecated: this historical partial-update PUT remains supported for existing clients. Use PATCH `/rates/{id}` for all new mutable commercial-term updates. Both routes require an exact strong If-Match ETag on `/api/v1`."
      : "Updates the required unit price and optional tiers, not immutable rate identity. `/api/v1` requires an exact strong If-Match ETag.",
    deprecated,
    request: UpdateRateRequestSchema,
    hasJsonBody: true,
    success: { status: 200, description: "Updated rate representation", schema: RateSchema },
    security: "operatorBearer",
    roles: ADMIN_ROLES,
    errors: [400, 401, 403, 404, 409, 412, 428, 500],
    requestHeaders: IdempotencyRequestHeadersSchema.merge(RateConditionalRequestHeadersSchema),
    responseHeaders: EtagResponseHeadersSchema,
    handler: async ({ input, principal, request, response }) => {
      const audit = { metadata: requestAuditMetadata(request, principal) };
      if (!isV1Request(request)) return rates.updateRate(input.params.id, input.body, audit);

      const result = await rates.updateRateConditionally(
        input.params.id,
        input.body,
        request.get("if-match"),
        audit
      );
      response.setHeader("ETag", result.etag);
      return result.rate;
    },
  });
}

const updateRateOperationDescriptor = updateRateOperation(
  "put",
  "updateRate",
  "Update a rate's mutable commercial terms",
  true
);
const patchRateOperation = updateRateOperation("patch", "patchRate", "Partially update a rate's mutable commercial terms");

/** Reused by the document generator; these are the objects Express mounts. */
export const rateOperations = [
  listRatesOperation,
  listComboDiscountsOperation,
  createComboDiscountOperation,
  getRateOperation,
  updateRateOperationDescriptor,
  patchRateOperation,
] as const;

export const ratesView = Router();
for (const operation of rateOperations) mountOperation(ratesView, operation);
