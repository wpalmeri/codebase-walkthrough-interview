import { ProblemDetailsSchema, type ProblemDetails } from "@meridian/contracts";

export { ProblemDetailsSchema, type ProblemDetails } from "@meridian/contracts";

export class ApplicationError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    const validatedProblem = ProblemDetailsSchema.parse(problem);
    super(validatedProblem.detail ?? validatedProblem.title);
    this.name = "ApplicationError";
    this.problem = validatedProblem;
  }
}

export class NotFoundError extends ApplicationError {
  constructor(detail?: string);
  constructor(code: string, detail: string);
  constructor(codeOrDetail?: string, detail?: string) {
    const code = detail === undefined ? "NOT_FOUND" : (codeOrDetail ?? "NOT_FOUND");
    const resolvedDetail = detail ?? codeOrDetail;
    super({
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code,
      ...(resolvedDetail === undefined ? {} : { detail: resolvedDetail }),
    });
    this.name = "NotFoundError";
  }
}

export class AuthenticationError extends ApplicationError {
  constructor() {
    super({
      type: "urn:meridian:problem:unauthorized",
      title: "Unauthorized",
      status: 401,
      code: "UNAUTHORIZED",
    });
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends ApplicationError {
  constructor() {
    super({
      type: "urn:meridian:problem:forbidden",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
    });
    this.name = "AuthorizationError";
  }
}

export class ConflictError extends ApplicationError {
  constructor(code = "CONFLICT", detail?: string) {
    super({
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code,
      ...(detail === undefined ? {} : { detail }),
    });
    this.name = "ConflictError";
  }
}

export class PreconditionError extends ApplicationError {
  constructor(code = "PRECONDITION_FAILED", detail?: string) {
    super({
      type: "urn:meridian:problem:precondition-failed",
      title: "Precondition Failed",
      status: 412,
      code,
      ...(detail === undefined ? {} : { detail }),
    });
    this.name = "PreconditionError";
  }
}

export class DomainInvariantError extends ApplicationError {
  constructor(code = "DOMAIN_INVARIANT", detail?: string) {
    super({
      type: "urn:meridian:problem:domain-invariant",
      title: "Unprocessable Entity",
      status: 422,
      code,
      ...(detail === undefined ? {} : { detail }),
    });
    this.name = "DomainInvariantError";
  }
}

export class ValidationError extends ApplicationError {
  constructor(detail = "Request validation failed") {
    super({
      type: "urn:meridian:problem:validation",
      title: "Bad Request",
      status: 400,
      code: "VALIDATION_ERROR",
      detail,
    });
    this.name = "ValidationError";
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function problem(problem: ProblemDetails): ProblemDetails {
  return ProblemDetailsSchema.parse(problem);
}

/** Maps only recognized public conditions. Unknown failures remain redacted. */
export function problemFromError(error: unknown): ProblemDetails {
  if (error instanceof ApplicationError) return error.problem;

  const code = prismaErrorCode(error);
  if (code === "P2025") {
    return problem({
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
  }
  if (code === "P2002") {
    return problem({
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "UNIQUE_CONSTRAINT",
    });
  }
  if (code === "P2003") {
    return problem({
      type: "urn:meridian:problem:domain-invariant",
      title: "Unprocessable Entity",
      status: 422,
      code: "RELATED_RESOURCE_NOT_FOUND",
    });
  }
  if (code === "P2004" || code === "P2011") {
    return problem({
      type: "urn:meridian:problem:domain-invariant",
      title: "Unprocessable Entity",
      status: 422,
      code: "DATABASE_CONSTRAINT",
    });
  }
  if (code === "P2014") {
    return problem({
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "RELATION_CONFLICT",
    });
  }
  if (code === "P2034" || code === "40001" || isPaymentAllocationConflict(error)) {
    return problem({
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "CONCURRENT_MODIFICATION",
    });
  }
  return problem({
    type: "urn:meridian:problem:internal-error",
    title: "Internal Server Error",
    status: 500,
    code: "INTERNAL_ERROR",
  });
}

function isPaymentAllocationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PaymentAllocationConflictError"
  );
}
