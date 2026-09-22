import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

export const REQUEST_ID_HEADER = "X-Request-ID";

/**
 * A bounded, opaque correlation token. Restricting the accepted alphabet keeps
 * the value safe to reflect as an HTTP header and prevents it becoming a log
 * injection vector.
 */
export const RequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const PrivateErrorStageSchema = z.enum(["UNHANDLED"]);
export type PrivateErrorStage = z.infer<typeof PrivateErrorStageSchema>;

/** A deliberately small, redacted event safe for operational error logging. */
export const PrivateErrorLogSchema = z
  .object({
    timestamp: z.iso.datetime({ offset: true }),
    level: z.literal("error"),
    requestId: RequestIdSchema,
    method: z.string().regex(/^[A-Z]{1,16}$/u),
    path: z.string().regex(/^\/[A-Za-z0-9/_.:-]*$/u).max(512),
    status: z.number().int().min(500).max(599),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    stage: PrivateErrorStageSchema,
  })
  .strict();
export type PrivateErrorLog = z.infer<typeof PrivateErrorLogSchema>;
export type PrivateErrorLogSink = (event: PrivateErrorLog) => void;

declare global {
  namespace Express {
    interface Request {
      /** Assigned at the first HTTP boundary; never trusted as an identity. */
      requestId: RequestId;
    }
  }
}

export type RequestContextOptions = {
  createRequestId?: () => string;
};

function invalidRequestIdProblem() {
  return {
    type: "urn:meridian:problem:invalid-request-id",
    title: "Invalid Request ID",
    status: 400,
    code: "INVALID_REQUEST_ID",
  } as const;
}

/**
 * Installs a server-derived request ID before parsing/authentication. Valid
 * client IDs are adopted for cross-service correlation; malformed values are
 * rejected without reflecting their contents.
 */
export function createRequestContextMiddleware(
  options: RequestContextOptions = {}
): RequestHandler {
  const createRequestId = options.createRequestId ?? randomUUID;

  return (request: Request, response: Response, next: NextFunction): void => {
    const inboundRequestId = request.get(REQUEST_ID_HEADER);
    const parsedRequestId = RequestIdSchema.safeParse(inboundRequestId);
    const requestId = parsedRequestId.success
      ? parsedRequestId.data
      : RequestIdSchema.parse(createRequestId());

    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    if (inboundRequestId !== undefined && !parsedRequestId.success) {
      response.status(400).type("application/problem+json").json(invalidRequestIdProblem());
      return;
    }

    next();
  };
}

/**
 * Prefer the Express route template to the raw URL. This retains useful route
 * context while excluding query values and path parameters that may be PII.
 */
export function normalizedRequestPath(request: Request): string {
  const routePath = request.route?.path;
  if (typeof routePath !== "string" || !/^\/[A-Za-z0-9/_.:-]*$/u.test(routePath)) {
    return "/unmatched";
  }

  const basePath = request.baseUrl;
  if (basePath.length > 0 && !/^\/[A-Za-z0-9/_.:-]*$/u.test(basePath)) {
    return "/unmatched";
  }

  const normalized = `${basePath}${routePath}`.replace(/\/+/gu, "/");
  return normalized.length <= 512 ? normalized : "/unmatched";
}

export function createPrivateErrorLog(
  request: Request,
  details: {
    status: number;
    code: string;
    stage: PrivateErrorStage;
    now?: Date;
  }
): PrivateErrorLog {
  return PrivateErrorLogSchema.parse({
    timestamp: (details.now ?? new Date()).toISOString(),
    level: "error",
    requestId: request.requestId,
    method: /^[A-Z]{1,16}$/u.test(request.method) ? request.method : "OTHER",
    path: normalizedRequestPath(request),
    status: details.status,
    code: details.code,
    stage: details.stage,
  });
}

/** Serializes only the redacted event shape, never the request or raw error. */
export function createJsonPrivateErrorLogger(
  write: (serializedEvent: string) => void = (serializedEvent) => console.error(serializedEvent)
): PrivateErrorLogSink {
  return (event) => {
    write(JSON.stringify(PrivateErrorLogSchema.parse(event)));
  };
}
