import { createHash } from "node:crypto";
import { IdempotencyRecordState } from "@prisma/client";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { PrincipalSchema, TenantIdSchema } from "./auth/principal";
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
  etag: z.string().min(1).max(2048).nullable(),
});
export type IdempotencyResponse = z.infer<typeof IdempotencyResponseSchema>;

export const IdempotencyRecordSchema = z.object({
  tenantId: TenantIdSchema,
  clientScope: z.string().length(64),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  route: z.string().min(1).max(512),
  idempotencyKey: IdempotencyKeySchema,
  requestFingerprint: z.string().length(64),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
const idempotencyHttpMethod = IdempotencyRecordSchema.shape.method.enum;
const idempotencyWriteMethods = new Set<string>(Object.values(idempotencyHttpMethod));

export type IdempotencyReservation =
  | { readonly kind: "reserved"; readonly id: string }
  | { readonly kind: "completed"; readonly response: IdempotencyResponse }
  | { readonly kind: "in-progress" }
  | { readonly kind: "fingerprint-mismatch" };

export interface IdempotencyStore {
  reserve(record: IdempotencyRecord): Promise<IdempotencyReservation>;
  complete(id: string, response: IdempotencyResponse): Promise<void>;
}

export type IdempotencyPersistenceErrorHandler = (error: unknown, request: Request) => void;

class IdempotencyHeaderError extends ApplicationError {
  constructor(
    code:
      | "INVALID_IDEMPOTENCY_KEY"
      | "INVALID_IDEMPOTENCY_CLIENT"
      | "IDEMPOTENCY_PRINCIPAL_REQUIRED"
      | "IDEMPOTENCY_NOT_SUPPORTED",
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
  if (!idempotencyWriteMethods.has(request.method)) return null;

  const suppliedKey = request.get("idempotency-key");
  if (suppliedKey === undefined) return null;
  const parsedKey = IdempotencyKeySchema.safeParse(suppliedKey);
  if (!parsedKey.success) {
    throw new IdempotencyHeaderError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a 1-128 character printable ASCII value");
  }

  // This endpoint returns a one-time plaintext credential. Capturing its
  // response would retain the secret in IdempotencyRecord, so reject the
  // header before any reservation is attempted.
  const route = routeFor(request);
  if (request.method === idempotencyHttpMethod.POST && route === "/api/tenant-api-keys") {
    throw new IdempotencyHeaderError(
      "IDEMPOTENCY_NOT_SUPPORTED",
      "Idempotency-Key is not supported when issuing one-time credentials"
    );
  }

  const suppliedClient = request.get("idempotency-client");
  const parsedClient = suppliedClient === undefined ? undefined : IdempotencyClientSchema.safeParse(suppliedClient);
  if (parsedClient !== undefined && !parsedClient.success) {
    throw new IdempotencyHeaderError(
      "INVALID_IDEMPOTENCY_CLIENT",
      "Idempotency-Client has an invalid format"
    );
  }

  const principal = PrincipalSchema.safeParse(request.principal);
  if (!principal.success) {
    throw new IdempotencyHeaderError(
      "IDEMPOTENCY_PRINCIPAL_REQUIRED",
      "Idempotency-Key requires a server-authenticated principal"
    );
  }

  return IdempotencyRecordSchema.parse({
    tenantId: principal.data.tenantId,
    // Never persist a bearer credential, its secret, or a hash derived from
    // it. Replay is isolated by the verified tenant and credential identity;
    // Idempotency-Client can only make that scope narrower.
    clientScope: hash(
      canonicalJson({
        tenantId: principal.data.tenantId,
        subjectId: principal.data.subjectId,
        credentialId: principal.data.credentialId,
        kind: principal.data.kind,
        role: principal.data.role,
        ...(parsedClient?.data === undefined ? {} : { client: parsedClient.data }),
      })
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
        ifMatch: request.get("if-match") ?? null,
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
      if (existing.state === IdempotencyRecordState.IN_PROGRESS) return { kind: "in-progress" };

      return {
        kind: "completed",
        response: IdempotencyResponseSchema.parse({
          status: existing.responseStatus,
          contentType: existing.responseContentType,
          bodyBase64: existing.responseBodyBase64,
          etag: existing.responseEtag,
        }),
      };
    },
    async complete(id, response) {
      await prisma.idempotencyRecord.update({
        where: { id },
        data: {
          state: IdempotencyRecordState.COMPLETED,
          responseStatus: response.status,
          responseContentType: response.contentType,
          responseBodyBase64: response.bodyBase64,
          responseEtag: response.etag,
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

function etag(response: Response): string | null {
  const value = response.getHeader("etag");
  return typeof value === "string" ? value : null;
}

function replay(response: Response, stored: IdempotencyResponse): void {
  response.status(stored.status);
  if (stored.contentType !== null) response.setHeader("content-type", stored.contentType);
  if (stored.etag !== null) response.setHeader("etag", stored.etag);
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
export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  onPersistenceError?: IdempotencyPersistenceErrorHandler
): RequestHandler {
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
        captureAndPersistResponse(request, response, store, reservation.id, onPersistenceError);
        next();
      },
      next
    );
  };
}

function captureAndPersistResponse(
  request: Request,
  response: Response,
  store: IdempotencyStore,
  recordId: string,
  onPersistenceError?: IdempotencyPersistenceErrorHandler
): void {
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
        etag: etag(response),
      });
      void store.complete(recordId, stored).then(
        () => {
          originalEnd(body, () => callbacks.forEach((done) => done()));
        },
        (error) => {
          // Observability is best-effort at this terminal boundary. A broken
          // user-provided sink must never prevent the fail-closed response.
          try {
            onPersistenceError?.(error, request);
          } catch {
            // The persistence failure remains the primary event; do not expose
            // either it or a secondary logging failure to the caller.
          }
          response.statusCode = 500;
          response.removeHeader("etag");
          response.removeHeader("content-length");
          response.removeHeader("content-encoding");
          response.removeHeader("last-modified");
          response.setHeader("cache-control", "no-store");
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
