import type { RequestHandler } from "express";
import { z } from "zod";

/** Server-assigned API compatibility mode; never derived from a client header. */
export const ApiVersionSchema = z.enum(["legacy", "v1"]);
export type ApiVersion = z.infer<typeof ApiVersionSchema>;

declare global {
  namespace Express {
    interface Request {
      /** Set by the mount boundary before shared API routes are reached. */
      apiVersion?: ApiVersion;
    }
  }
}

export function assignApiVersion(version: ApiVersion): RequestHandler {
  const parsed = ApiVersionSchema.parse(version);
  return (request, _response, next) => {
    request.apiVersion = parsed;
    next();
  };
}

/** New safety contracts apply only to the explicitly versioned API surface. */
export function isV1Request(request: Pick<Express.Request, "apiVersion">): boolean {
  return request.apiVersion === "v1";
}
