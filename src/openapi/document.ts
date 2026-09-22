import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type ResponseConfig,
} from "@asteasolutions/zod-to-openapi";
import {
  ProblemDetailsSchema,
  ValidationErrorResponseSchema,
} from "@meridian/contracts";
import { openApiPath, requestParts, type AnyApiOperation, type ApiErrorStatus } from "./operation";

const JSON_MEDIA_TYPE = "application/json";
const PROBLEM_MEDIA_TYPE = "application/problem+json";

/**
 * Produces an internal, deterministic OpenAPI 3.1 document from mounted route
 * definitions. It intentionally describes only the versioned contract; `/api`
 * remains an operational legacy adapter and is never inferred as a second API.
 */
export function createOpenApiV1Document(operations: readonly AnyApiOperation[]) {
  assertUniqueOperationIdentity(operations);
  const registry = new OpenAPIRegistry();
  // Existing contracts are constructed before this optional documentation
  // module loads. Zod 4's native metadata avoids prototype augmentation and
  // gives the generator stable component identities without copying schemas.
  const problemDetails = ProblemDetailsSchema.meta({ id: "ProblemDetails" });
  const validationError = ValidationErrorResponseSchema.meta({ id: "ValidationError" });
  registry.registerComponent("securitySchemes", "tenantBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "Meridian tenant API key",
    description: "An opaque server-to-server tenant API key. Browser sessions are a separate future credential flow.",
  });

  for (const operation of operations) {
    const parts = requestParts(operation.request);
    const responses: Record<string, ResponseConfig> = {
      [String(operation.success.status)]: {
        description: operation.success.description,
        headers: operation.responseHeaders,
        content: { [JSON_MEDIA_TYPE]: { schema: operation.success.schema } },
      },
    };
    for (const status of operation.errors) {
      responses[String(status)] = errorResponse(status, problemDetails, validationError);
    }

    registry.registerPath({
      method: operation.method,
      path: openApiPath(operation.path),
      operationId: operation.operationId,
      summary: operation.summary,
      ...(operation.description === undefined ? {} : { description: operation.description }),
      ...(operation.deprecated === undefined ? {} : { deprecated: operation.deprecated }),
      security: [{ [operation.security]: [] }],
      request: {
        params: parts.params,
        query: parts.query,
        headers: operation.requestHeaders,
        ...(operation.hasJsonBody
          ? { body: { required: true, content: { [JSON_MEDIA_TYPE]: { schema: parts.body } } } }
          : {}),
      },
      responses,
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Meridian Billing API",
      version: "1.0.0",
      description: "The versioned Meridian server-to-server API contract.",
    },
    servers: [{ url: "/api/v1", description: "Versioned API" }],
  });
}

function errorResponse(
  status: ApiErrorStatus,
  problemDetails: typeof ProblemDetailsSchema,
  validationError: typeof ValidationErrorResponseSchema
): ResponseConfig {
  if (status === 400) {
    return {
      description: "Invalid request syntax, headers, or validated input",
      content: {
        [JSON_MEDIA_TYPE]: { schema: validationError },
        [PROBLEM_MEDIA_TYPE]: { schema: problemDetails },
      },
    };
  }
  return {
    description: `Error ${status}`,
    content: { [PROBLEM_MEDIA_TYPE]: { schema: problemDetails } },
  };
}

function assertUniqueOperationIdentity(operations: readonly AnyApiOperation[]): void {
  const pathMethods = new Set<string>();
  const operationIds = new Set<string>();
  for (const operation of operations) {
    const identity = `${operation.method} ${openApiPath(operation.path)}`;
    if (pathMethods.has(identity)) throw new Error(`Duplicate OpenAPI operation: ${identity}`);
    if (operationIds.has(operation.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${operation.operationId}`);
    }
    pathMethods.add(identity);
    operationIds.add(operation.operationId);
  }
}
