import type { FastifyRequest } from "fastify";
import type { RequestContext } from "../lib/context.js";
import { loadContext } from "../permissions/context-loader.js";

/**
 * Resolves the acting user for a request. There is no real authentication in
 * this environment: the UI and integration tests send x-user-id (or a userId
 * query/body member). Requests that send nothing fall back to the primary
 * org's admin so that older internal tools keep working.
 */

const DEFAULT_USER_ID = "user_admin";

export function requestUserId(request: FastifyRequest): string {
  const header = request.headers["x-user-id"];
  if (typeof header === "string" && header.length > 0) return header;
  const query = request.query as { userId?: string } | undefined;
  if (query?.userId) return query.userId;
  const body = request.body as { userId?: string } | undefined;
  if (body?.userId) return body.userId;
  return DEFAULT_USER_ID;
}

export async function contextFor(request: FastifyRequest): Promise<RequestContext> {
  return loadContext(requestUserId(request));
}
