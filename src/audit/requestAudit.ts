import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { PrincipalSchema, TenantIdSchema, type Principal } from "../auth/principal";
import { RequestIdSchema } from "../runtime/requestContext";
import {
  AuditActionSchema,
  AuditResourceKindSchema,
  appendAuditEvent,
  type AuditEvent,
  type AuditEventRepository,
} from "./auditEvent";

export type RequestAuditRequest = Pick<Request, "requestId"> & {
  get(name: string): string | undefined;
};

const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "Idempotency-Key must contain printable ASCII characters only");

/**
 * The only audit metadata a request handler may supply to a business mutation.
 * Every field comes from middleware or the already-authenticated principal;
 * neither resource identity nor actor identity can come from JSON input.
 */
export const RequestAuditMetadataSchema = z.strictObject({
  tenantId: TenantIdSchema,
  principal: z.strictObject({
    kind: PrincipalSchema.shape.kind,
    subjectId: PrincipalSchema.shape.subjectId,
    credentialId: PrincipalSchema.shape.credentialId,
  }),
  requestId: RequestIdSchema,
  // This value is intentionally transient. appendAuditEvent hashes it before
  // persistence, and no returned shape includes it.
  idempotencyKey: IdempotencyKeySchema.optional(),
});
export type RequestAuditMetadata = z.infer<typeof RequestAuditMetadataSchema>;

export const RequestAuditEventSchema = z.strictObject({
  action: AuditActionSchema,
  resourceKind: AuditResourceKindSchema,
  resourceId: z.string().min(1).max(512),
});
export type RequestAuditEvent = z.infer<typeof RequestAuditEventSchema>;

export type RequestAuditAppenderOptions = {
  /** Defaults to cryptographically strong random UUIDs in production. */
  readonly createId?: () => string;
  /** Defaults to the server clock; callers never supply a client timestamp. */
  readonly now?: () => Date;
};

/**
 * Derives audit metadata only after authentication and request-context
 * middleware have completed. It deliberately does not accept tenant or actor
 * fields from an operation request body.
 */
export function requestAuditMetadata(
  request: RequestAuditRequest,
  principal: Principal
): RequestAuditMetadata {
  const authenticatedPrincipal = PrincipalSchema.parse(principal);
  const idempotencyKey = request.get("idempotency-key");
  return RequestAuditMetadataSchema.parse({
    tenantId: authenticatedPrincipal.tenantId,
    principal: {
      kind: authenticatedPrincipal.kind,
      subjectId: authenticatedPrincipal.subjectId,
      credentialId: authenticatedPrincipal.credentialId,
    },
    requestId: request.requestId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}

/**
 * Appends an audit event through a caller-owned repository/transaction. The
 * default ID and clock are trusted server facilities; injectable functions
 * keep rollback tests deterministic without weakening production behavior.
 */
export async function appendRequestAuditEvent(
  repository: AuditEventRepository,
  metadata: RequestAuditMetadata,
  event: RequestAuditEvent,
  options: RequestAuditAppenderOptions = {}
): Promise<AuditEvent> {
  const parsedMetadata = RequestAuditMetadataSchema.parse(metadata);
  const parsedEvent = RequestAuditEventSchema.parse(event);
  return appendAuditEvent(
    repository,
    { ...parsedMetadata, ...parsedEvent },
    {
      id: (options.createId ?? randomUUID)(),
      now: options.now ?? (() => new Date()),
    }
  );
}

/** Injectable only to exercise transaction failure paths in focused tests. */
export type RequestAuditAppender = typeof appendRequestAuditEvent;
