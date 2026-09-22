import {
  ValidationErrorResponseSchema,
  type ValidationIssue,
} from "@meridian/contracts";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

export class RequestValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("Request validation failed");
    this.name = "RequestValidationError";
    this.issues = issues;
  }
}

export function validationErrorBody(error: RequestValidationError) {
  return ValidationErrorResponseSchema.parse({
    error: error.message,
    code: "VALIDATION_ERROR",
    issues: error.issues,
  });
}

export function validateRequest<T>(schema: z.ZodType<T>, req: Request): T {
  const result = schema.safeParse({
    params: req.params,
    query: req.query,
    body: req.body,
  });
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String).join("."),
        message: issue.message,
      }))
    );
  }
  return result.data;
}

// Express 4 doesn't catch async errors; wrap handlers so they reach the error middleware.
export function h(
  fn: (req: Request, res: Response) => Promise<unknown>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res)
      .then((result) => {
        if (!res.headersSent) res.json(result);
      })
      .catch((error: unknown) => {
        if (error instanceof RequestValidationError) {
          res.status(400).json(validationErrorBody(error));
          return;
        }
        next(error);
      });
  };
}
