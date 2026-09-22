import { CustomerSchema, ListCustomersRequestSchema } from "@meridian/contracts";
import { Router } from "express";
import { READ_ROLES } from "../auth/authorization";
import * as customers from "../controllers/customerController";
import { defineOperation, mountOperation } from "../openapi/operation";

const listCustomersOperation = defineOperation({
  method: "get",
  path: "/customers",
  operationId: "listCustomers",
  summary: "List customers",
  request: ListCustomersRequestSchema,
  hasJsonBody: false,
  success: { status: 200, description: "Customers visible to the tenant", schema: CustomerSchema.array() },
  security: "tenantBearer",
  roles: READ_ROLES,
  errors: [400, 401, 500],
  handler: async ({ principal }) => customers.listCustomers(principal.tenantId),
});

/** Reused by the document generator; these are the objects Express mounts. */
export const customerOperations = [listCustomersOperation] as const;

export const customersView = Router();
for (const operation of customerOperations) mountOperation(customersView, operation);
