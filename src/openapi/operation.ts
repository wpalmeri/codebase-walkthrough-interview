import type { Principal } from "../auth/principal";
import { requireRole } from "../auth/authorization";
import { REQUEST_ID_HEADER, RequestIdSchema } from "../runtime/requestContext";
import { h, validateRequest } from "../views/helpers";
import type { Request, Response, Router } from "express";
import { z } from "zod";

export const ApiOperationMethodSchema = z.enum(["get", "post", "put", "patch", "delete"]);
export type ApiOperationMethod = z.infer<typeof ApiOperationMethodSchema>;

export const ApiSecuritySchema = z.enum(["tenantBearer"]);
export type ApiSecurity = z.infer<typeof ApiSecuritySchema>;

export const ApiErrorStatusSchema = z.union([
  z.literal(400),
  z.literal(401),
  z.literal(403),
  z.literal(404),
  z.literal(409),
  z.literal(412),
  z.literal(422),
  z.literal(428),
  z.literal(500),
]);
export type ApiErrorStatus = z.infer<typeof ApiErrorStatusSchema>;

export const RequestIdRequestHeadersSchema = z.object({
  [REQUEST_ID_HEADER]: RequestIdSchema.optional(),
});
export const RequestIdResponseHeadersSchema = z.object({
  [REQUEST_ID_HEADER]: RequestIdSchema,
});

export const IdempotencyRequestHeadersSchema = z.object({
  "Idempotency-Key": z.string().min(1).max(128).optional(),
  "Idempotency-Client": z.string().min(1).max(128).optional(),
});

export const RateConditionalRequestHeadersSchema = z.object({
  "If-Match": z.string().min(1).max(2048),
});
export const EtagResponseHeadersSchema = z.object({
  ETag: z.string().min(1).max(2048),
});

type RequestComposite = z.ZodType<{
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
}>;

export interface ApiOperationContext<Input> {
  readonly request: Request;
  readonly response: Response;
  readonly input: Input;
  readonly principal: Principal;
}

/**
 * The sole definition of a route's HTTP identity, runtime validation, access
 * boundary, and OpenAPI metadata. `mountOperation` and document generation
 * consume this same object, so a path cannot be edited in one place only.
 */
export interface ApiOperation<RequestSchema extends RequestComposite, SuccessSchema extends z.ZodType> {
  readonly method: ApiOperationMethod;
  /** Express syntax, converted to OpenAPI `{parameter}` syntax centrally. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly request: RequestSchema;
  readonly hasJsonBody: boolean;
  readonly success: {
    readonly status: number;
    readonly description: string;
    /** Runtime schema for every mounted adapter, including retained legacy shapes. */
    readonly schema: SuccessSchema;
    /** Optional versioned-only schema when the legacy adapter has a different response shape. */
    readonly openApiSchema?: z.ZodType;
  };
  readonly security: ApiSecurity;
  readonly roles: readonly Principal["role"][];
  readonly errors: readonly ApiErrorStatus[];
  readonly requestHeaders: z.ZodObject;
  readonly responseHeaders: z.ZodObject;
  readonly handler: (context: ApiOperationContext<z.output<RequestSchema>>) => Promise<unknown>;
}

export type AnyApiOperation = ApiOperation<RequestComposite, z.ZodType>;

export class ResponseContractViolationError extends Error {
  constructor(operationId: string) {
    // Deliberately omit parsing details and payload data: they may contain PII
    // and must never cross the public error boundary.
    super(`Response contract violation for ${operationId}`);
    this.name = "ResponseContractViolationError";
  }
}

export function defineOperation<RequestSchema extends RequestComposite, SuccessSchema extends z.ZodType>(
  operation: Omit<ApiOperation<RequestSchema, SuccessSchema>, "requestHeaders" | "responseHeaders"> & {
    readonly requestHeaders?: z.ZodObject;
    readonly responseHeaders?: z.ZodObject;
  }
): ApiOperation<RequestSchema, SuccessSchema> {
  return {
    ...operation,
    requestHeaders: mergeHeaders(RequestIdRequestHeadersSchema, operation.requestHeaders),
    responseHeaders: mergeHeaders(RequestIdResponseHeadersSchema, operation.responseHeaders),
  };
}

/** Mounts the same definition used by OpenAPI generation and validates output before JSON serialization. */
export function mountOperation(router: Router, operation: AnyApiOperation): void {
  const handler = h(async (request, response) => {
    const input = validateRequest(operation.request, request);
    const principal = requireRole(request, operation.roles);
    const value = await operation.handler({ request, response, input, principal });
    const result = operation.success.schema.safeParse(value);
    if (!result.success) throw new ResponseContractViolationError(operation.operationId);
    if (!response.headersSent) response.status(operation.success.status);
    return result.data;
  });

  switch (operation.method) {
    case "get":
      router.get(operation.path, handler);
      return;
    case "post":
      router.post(operation.path, handler);
      return;
    case "put":
      router.put(operation.path, handler);
      return;
    case "patch":
      router.patch(operation.path, handler);
      return;
    case "delete":
      router.delete(operation.path, handler);
      return;
  }
}

/** Converts the only Express-specific path syntax at the shared boundary. */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
}

export function requestParts(schema: RequestComposite): {
  readonly params: z.ZodObject;
  readonly query: z.ZodObject;
  readonly body: z.ZodType;
} {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("API operation requests must be Zod objects with params, query, and body");
  }
  const { params, query, body } = schema.shape;
  if (!(params instanceof z.ZodObject) || !(query instanceof z.ZodObject) || !(body instanceof z.ZodType)) {
    throw new Error("API operation request shape must expose Zod params, query, and body schemas");
  }
  return { params, query, body };
}

function mergeHeaders(base: z.ZodObject, extra: z.ZodObject | undefined): z.ZodObject {
  if (extra === undefined) return base;
  return z.object({ ...base.shape, ...extra.shape });
}
