import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { prisma } from "./db";
import { ApplicationError, ConflictError } from "./errors";

const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "Idempotency-Key must contain printable ASCII characters only");
const IdempotencyClientSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, "Idempotency-Client has an invalid format");

export const IdempotencyResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  contentType: z.string().min(1).max(255).nullable(),
  bodyBase64: z.string(),
});
export type IdempotencyResponse = z.infer<typeof IdempotencyResponseSchema>;

export const IdempotencyRecordSchema = z.object({
  clientScope: z.string().length(64),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  route: z.string().min(1).max(512),
  idempotencyKey: IdempotencyKeySchema,
  requestFingerprint: z.string().length(64),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export type IdempotencyReservation =
  | { readonly kind: "reserved"; readonly id: string }
  | { readonly kind: "completed"; readonly response: IdempotencyResponse }
  | { readonly kind: "in-progress" }
  | { readonly kind: "fingerprint-mismatch" };

export interface IdempotencyStore {
  reserve(record: IdempotencyRecord): Promise<IdempotencyReservation>;
  complete(id: string, response: IdempotencyResponse): Promise<void>;
}

class IdempotencyHeaderError extends ApplicationError {
  constructor(
    code:
      | "INVALID_IDEMPOTENCY_KEY"
      | "INVALID_IDEMPOTENCY_CLIENT"
      | "IDEMPOTENCY_CLIENT_REQUIRED",
    detail: string
  ) {
    super({
      type: "urn:meridian:problem:idempotency-header",
      title: "Bad Request",
      status: 400,
      code,
      detail,
    });
    this.name = "IdempotencyHeaderError";
  }
}

class IdempotencyConflictError extends ConflictError {
  constructor(code: "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REQUEST_IN_PROGRESS", detail: string) {
    super(code, detail);
    this.name = "IdempotencyConflictError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function routeFor(request: Request): string {
  // Legacy and v1 are aliases for the same operations today. Give them one
  // replay scope so a retry cannot double-apply merely because a client follows
  // the advertised successor-version link.
  const path = request.originalUrl.split("?", 1)[0] ?? request.path;
  const route = path.replace(/^\/api\/v1(?=\/|$)/u, "/api");
  if (route.length === 0 || route.length > 512) {
    throw new IdempotencyHeaderError("INVALID_IDEMPOTENCY_KEY", "Request route cannot be idempotently replayed");
  }
  return route;
}

function recordFor(request: Request): IdempotencyRecord | null {
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(request.method)) return null;

  const suppliedKey = request.get("idempotency-key");
  if (suppliedKey === undefined) return null;
  const parsedKey = IdempotencyKeySchema.safeParse(suppliedKey);
  if (!parsedKey.success) {
    throw new IdempotencyHeaderError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a 1-128 character printable ASCII value");
  }

  const authorization = request.get("authorization");
  const suppliedClient = request.get("idempotency-client");
  if (authorization === undefined && suppliedClient === undefined) {
    throw new IdempotencyHeaderError(
      "IDEMPOTENCY_CLIENT_REQUIRED",
      "Idempotency-Key requires Authorization or Idempotency-Client to isolate clients"
    );
  }
  const parsedClient = suppliedClient === undefined ? undefined : IdempotencyClientSchema.safeParse(suppliedClient);
  if (parsedClient !== undefined && !parsedClient.success) {
    throw new IdempotencyHeaderError(
      "INVALID_IDEMPOTENCY_CLIENT",
      "Idempotency-Client has an invalid format"
    );
  }

  const route = routeFor(request);
  return IdempotencyRecordSchema.parse({
    // Never persist even a hash derived from the bearer secret. A supplied
    // stable client ID survives credential rotation; the current single-key
    // deployment otherwise has one stable authenticated scope.
    clientScope: hash(
      parsedClient?.data === undefined
        ? "authenticated:meridian-api"
        : `client:${parsedClient.data}`
    ),
    method: request.method,
    route,
    idempotencyKey: parsedKey.data,
    requestFingerprint: hash(
      canonicalJson({
        method: request.method,
        route,
        query: request.query,
        body: request.body,
        contentType: request.get("content-type") ?? null,
      })
    ),
  });
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export function createPrismaIdempotencyStore(): IdempotencyStore {
  return {
    async reserve(record) {
      try {
        const created = await prisma.idempotencyRecord.create({ data: record });
        return { kind: "reserved", id: created.id };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
      }

      const existing = await prisma.idempotencyRecord.findUnique({
        where: {
          clientScope_method_route_idempotencyKey: {
            clientScope: record.clientScope,
            method: record.method,
            route: record.route,
            idempotencyKey: record.idempotencyKey,
          },
        },
      });
      // A raced insert may not yet be observable on a replica; fail closed rather than execute twice.
      if (existing === null) return { kind: "in-progress" };
      if (existing.requestFingerprint !== record.requestFingerprint) return { kind: "fingerprint-mismatch" };
      if (existing.state === "IN_PROGRESS") return { kind: "in-progress" };

      return {
        kind: "completed",
        response: IdempotencyResponseSchema.parse({
          status: existing.responseStatus,
          contentType: existing.responseContentType,
          bodyBase64: existing.responseBodyBase64,
        }),
      };
    },
    async complete(id, response) {
      await prisma.idempotencyRecord.update({
        where: { id },
        data: {
          state: "COMPLETED",
          responseStatus: response.status,
          responseContentType: response.contentType,
          responseBodyBase64: response.bodyBase64,
          completedAt: new Date(),
        },
      });
    },
  };
}

function contentType(response: Response): string | null {
  const value = response.getHeader("content-type");
  return typeof value === "string" ? value : null;
}

function replay(response: Response, stored: IdempotencyResponse): void {
  response.status(stored.status);
  if (stored.contentType !== null) response.setHeader("content-type", stored.contentType);
  response.end(Buffer.from(stored.bodyBase64, "base64"));
}

const INTERNAL_ERROR_BODY = Buffer.from(
  JSON.stringify({
    type: "urn:meridian:problem:internal-error",
    title: "Internal Server Error",
    status: 500,
    code: "INTERNAL_ERROR",
  })
);

/**
 * Reserves a database row before a mutating handler runs, then persists the exact
 * response before it is released to the caller. An interrupted reservation stays
 * in progress and fails closed, which is preferable to applying a charge twice.
 */
export function createIdempotencyMiddleware(store: IdempotencyStore): RequestHandler {
  return (request, response, next) => {
    let record: IdempotencyRecord | null;
    try {
      record = recordFor(request);
    } catch (error) {
      next(error);
      return;
    }
    if (record === null) {
      next();
      return;
    }

    void store.reserve(record).then(
      (reservation) => {
        if (reservation.kind === "completed") {
          replay(response, reservation.response);
          return;
        }
        if (reservation.kind === "fingerprint-mismatch") {
          next(new IdempotencyConflictError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was used with a different request"));
          return;
        }
        if (reservation.kind === "in-progress") {
          next(
            new IdempotencyConflictError(
              "IDEMPOTENCY_REQUEST_IN_PROGRESS",
              "An identical request is already being processed; retry later"
            )
          );
          return;
        }
        captureAndPersistResponse(response, store, reservation.id);
        next();
      },
      next
    );
  };
}

function captureAndPersistResponse(response: Response, store: IdempotencyStore, recordId: string): void {
  const originalEnd = response.end.bind(response);
  const callbacks: (() => void)[] = [];
  const chunks: Buffer[] = [];
  let ended = false;

  Object.defineProperty(response, "write", {
    configurable: true,
    value: (...args: unknown[]): boolean => {
      const [chunk, encoding, callback] = args;
      callbacksFor(encoding, callback, callbacks);
      chunks.push(responseChunk(chunk, encoding));
      return true;
    },
  });

  Object.defineProperty(response, "end", {
    configurable: true,
    value: (...args: unknown[]): Response => {
      const [chunk, encoding, callback] = args;
      if (ended) return response;
      ended = true;
      callbacksFor(encoding, callback, callbacks);
      if (chunk !== undefined && chunk !== null) {
        chunks.push(responseChunk(chunk, encoding));
      }
      const body = Buffer.concat(chunks);
      const stored = IdempotencyResponseSchema.parse({
        status: response.statusCode,
        contentType: contentType(response),
        bodyBase64: body.toString("base64"),
      });
      void store.complete(recordId, stored).then(
        () => {
          originalEnd(body, () => callbacks.forEach((done) => done()));
        },
        () => {
          response.statusCode = 500;
          response.setHeader("content-type", "application/problem+json");
          originalEnd(INTERNAL_ERROR_BODY, () => callbacks.forEach((done) => done()));
        }
      );
      return response;
    },
  });
}

function responseChunk(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, isBufferEncoding(encoding) ? encoding : undefined);
  throw new TypeError("Idempotent responses must be written as strings or Uint8Array values");
}

function callbacksFor(encoding: unknown, callback: unknown, callbacks: (() => void)[]): void {
  if (isResponseCallback(encoding)) callbacks.push(encoding);
  if (isResponseCallback(callback)) callbacks.push(callback);
}

function isBufferEncoding(value: unknown): value is BufferEncoding {
  return typeof value === "string" && Buffer.isEncoding(value);
}

function isResponseCallback(value: unknown): value is () => void {
  return typeof value === "function";
}
