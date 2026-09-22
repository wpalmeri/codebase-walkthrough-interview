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
  success: { status: 200, description: "Rates visible to the tenant", schema: RateSchema.array() },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 404, 500],
  handler: async ({ input, principal }) => rates.listRates(principal.tenantId, input.query.customerId),
});

const listComboDiscountsOperation = defineOperation({
  method: "get",
  path: "/rates/combos",
  operationId: "listComboDiscounts",
  summary: "List tenant combo discounts",
  request: ListComboDiscountsRequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Customer-specific and tenant-wide combo discounts",
    schema: ComboDiscountSchema.array(),
  },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 404, 500],
  handler: async ({ input, principal }) => rates.listComboDiscounts(principal.tenantId, input.query.customerId),
});

const createComboDiscountOperation = defineOperation({
  method: "post",
  path: "/rates/combos",
  operationId: "createComboDiscount",
  summary: "Create a tenant combo discount",
  request: CreateComboDiscountRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Created combo discount", schema: ComboDiscountSchema },
  security: "tenantBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 404, 409, 422, 500],
  requestHeaders: IdempotencyRequestHeadersSchema,
  handler: async ({ input, principal, request }) =>
    rates.createComboDiscount(principal.tenantId, {
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
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 404, 500],
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    const result = await rates.getVersionedRate(principal.tenantId, input.params.id);
    if (isV1Request(request)) response.setHeader("ETag", result.etag);
    return result.rate;
  },
});

const updateRateOperation = defineOperation({
  method: "put",
  path: "/rates/:id",
  operationId: "updateRate",
  summary: "Update a rate's mutable commercial terms",
  description:
    "This updates the unit price and optional tiers, not immutable rate identity. `/api/v1` requires an exact strong If-Match ETag.",
  request: UpdateRateRequestSchema,
  hasJsonBody: true,
  success: { status: 200, description: "Updated rate representation", schema: RateSchema },
  security: "tenantBearer",
  roles: ADMIN_ROLES,
  errors: [400, 401, 403, 404, 409, 412, 428, 500],
  requestHeaders: IdempotencyRequestHeadersSchema.merge(RateConditionalRequestHeadersSchema),
  responseHeaders: EtagResponseHeadersSchema,
  handler: async ({ input, principal, request, response }) => {
    const audit = { metadata: requestAuditMetadata(request, principal) };
    if (!isV1Request(request)) return rates.updateRate(principal.tenantId, input.params.id, input.body, audit);

    const result = await rates.updateRateConditionally(
      principal.tenantId,
      input.params.id,
      input.body,
      request.get("if-match"),
      audit
    );
    response.setHeader("ETag", result.etag);
    return result.rate;
  },
});

/** Reused by the document generator; these are the objects Express mounts. */
export const rateOperations = [
  listRatesOperation,
  listComboDiscountsOperation,
  createComboDiscountOperation,
  getRateOperation,
  updateRateOperation,
] as const;

export const ratesView = Router();
for (const operation of rateOperations) mountOperation(ratesView, operation);
