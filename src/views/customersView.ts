import {
  CustomerPageSchema,
  CustomerSchema,
  ListCustomersRequestSchema,
  ListCustomersV1RequestSchema,
} from "@meridian/contracts";
import { Router } from "express";
import { z } from "zod";
import { READ_ROLES } from "../auth/authorization";
import * as customers from "../controllers/customerController";
import { isV1Request } from "../http/apiVersion";
import { formatNextPageLink } from "../http/pagination";
import { PaginationResponseHeadersSchema, defineOperation, mountOperation } from "../openapi/operation";
import { RequestValidationError, validateRequest } from "./helpers";

const CustomerListResponseSchema = z.union([CustomerSchema.array(), CustomerPageSchema]);

const listCustomersOperation = defineOperation({
  method: "get",
  path: "/customers",
  operationId: "listCustomers",
  summary: "List customers",
  description:
    "`/api/v1` returns cursor-paginated customers ordered by name then id; the legacy `/api` adapter remains an array.",
  request: ListCustomersV1RequestSchema,
  hasJsonBody: false,
  success: {
    status: 200,
    description: "Cursor-paginated customer page",
    schema: CustomerListResponseSchema,
    openApiSchema: CustomerPageSchema,
  },
  security: "operatorBearer",
  roles: READ_ROLES,
  errors: [400, 401, 500],
  responseHeaders: PaginationResponseHeadersSchema,
  handler: async ({ input, request, response }) => {
    if (!isV1Request(request)) {
      // The v1 contract is intentionally not accepted by legacy clients.
      validateRequest(ListCustomersRequestSchema, request);
      return customers.listCustomers();
    }

    const page = await customers.listCustomersPage(input.query);
    if (!page.ok) {
      throw new RequestValidationError([
        {
          code: page.code,
          path: "query.cursor",
          message: "Cursor is invalid for this customer query",
        },
      ]);
    }
    const link = formatNextPageLink(request.originalUrl, page.page.page.nextCursor);
    if (link !== undefined) response.append("Link", link);
    return page.page;
  },
});

/** Reused by the document generator; these are the objects Express mounts. */
export const customerOperations = [listCustomersOperation] as const;

export const customersView = Router();
for (const operation of customerOperations) mountOperation(customersView, operation);
