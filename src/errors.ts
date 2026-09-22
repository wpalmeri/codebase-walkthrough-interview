/** Stable, client-safe RFC 9457-style problem details. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
}

export class ApplicationError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "ApplicationError";
    this.problem = problem;
  }
}

export class NotFoundError extends ApplicationError {
  constructor(detail?: string) {
    super({
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
      ...(detail === undefined ? {} : { detail }),
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

/** Maps only recognized public conditions. Unknown failures remain redacted. */
export function problemFromError(error: unknown): ProblemDetails {
  if (error instanceof ApplicationError) return error.problem;

  const code = prismaErrorCode(error);
  if (code === "P2025") {
    return {
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    };
  }
  if (code === "P2002") {
    return {
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "UNIQUE_CONSTRAINT",
    };
  }
  if (code === "P2034" || code === "40001" || isPaymentAllocationConflict(error)) {
    return {
      type: "urn:meridian:problem:conflict",
      title: "Conflict",
      status: 409,
      code: "CONCURRENT_MODIFICATION",
    };
  }
  return {
    type: "urn:meridian:problem:internal-error",
    title: "Internal Server Error",
    status: 500,
    code: "INTERNAL_ERROR",
  };
}

function isPaymentAllocationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PaymentAllocationConflictError"
  );
}
