export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

export class UnprocessableError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
