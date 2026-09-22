import { createHash } from "node:crypto";
import {
  AuditAction as PrismaAuditAction,
  AuditPrincipalKind as PrismaAuditPrincipalKind,
  AuditResourceKind as PrismaAuditResourceKind,
} from "@prisma/client";
import { z } from "zod";
import { TenantIdSchema } from "../auth/principal";
import { RequestIdSchema } from "../runtime/requestContext";

export const AuditActionSchema = z.enum(PrismaAuditAction);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** Kept aligned with the server-authenticated principal boundary. */
export const AuditPrincipalKindSchema = z.enum(PrismaAuditPrincipalKind);
export type AuditPrincipalKind = z.infer<typeof AuditPrincipalKindSchema>;

export const AuditResourceKindSchema = z.enum(PrismaAuditResourceKind);
export type AuditResourceKind = z.infer<typeof AuditResourceKindSchema>;

const AUDIT_RESOURCE_FOR_ACTION = {
  RATE_CREATED: "RATE",
  RATE_UPDATED: "RATE",
  ORDER_CREATED: "ORDER",
  ORDER_UPDATED: "ORDER",
  ORDER_INVOICED: "ORDER",
  INVOICE_CREATED: "INVOICE",
  INVOICE_POSTED: "INVOICE",
  INVOICE_SENT: "INVOICE",
  INVOICE_VOIDED: "INVOICE",
  INVOICE_DELIVERY_REQUESTED: "INVOICE_DELIVERY",
  INVOICE_DELIVERY_UPDATED: "INVOICE_DELIVERY",
  PAYMENT_RECORDED: "PAYMENT",
  PAYMENT_APPLIED: "PAYMENT_APPLICATION",
  PAYMENT_APPLICATION_REVERSED: "PAYMENT_APPLICATION_REVERSAL",
  TENANT_API_KEY_ISSUED: "TENANT_API_KEY",
  TENANT_API_KEY_REVOKED: "TENANT_API_KEY",
} as const satisfies Record<AuditAction, AuditResourceKind>;

function requireMatchingResource(
  value: { action: AuditAction; resourceKind: AuditResourceKind },
  context: z.RefinementCtx
): void {
  if (AUDIT_RESOURCE_FOR_ACTION[value.action] !== value.resourceKind) {
    context.addIssue({
      code: "custom",
      path: ["resourceKind"],
      message: "Resource kind does not match the audit action",
    });
  }
}

const AuditEventIdSchema = z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/u);
const PrincipalIdentitySchema = z
  .strictObject({
    kind: AuditPrincipalKindSchema,
    subjectId: z.string().min(1).max(191),
    credentialId: z.string().min(1).max(191),
  });
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "Idempotency-Key must contain printable ASCII characters only");
export const IdempotencyKeyFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** The only persistable audit shape: it deliberately has no generic payload. */
export const AuditEventWriteSchema = z
  .strictObject({
    id: AuditEventIdSchema,
    tenantId: TenantIdSchema,
    action: AuditActionSchema,
    principalKind: AuditPrincipalKindSchema,
    principalSubject: z.string().min(1).max(191),
    principalCredentialId: z.string().min(1).max(191),
    requestId: RequestIdSchema,
    idempotencyKeyFingerprint: IdempotencyKeyFingerprintSchema.nullable(),
    resourceKind: AuditResourceKindSchema,
    resourceId: z.string().min(1).max(512),
    occurredAt: z.coerce.date(),
  })
  .superRefine(requireMatchingResource);
export type AuditEventWrite = z.infer<typeof AuditEventWriteSchema>;

/** Database output is validated again so storage drift cannot escape callers. */
export const AuditEventSchema = AuditEventWriteSchema;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Input contains only server-derived metadata and a transient raw key to hash. */
export const AuditEventAppendInputSchema = z
  .strictObject({
    tenantId: TenantIdSchema,
    action: AuditActionSchema,
    principal: PrincipalIdentitySchema,
    requestId: RequestIdSchema,
    idempotencyKey: IdempotencyKeySchema.optional(),
    resourceKind: AuditResourceKindSchema,
    resourceId: z.string().min(1).max(512),
  })
  .superRefine(requireMatchingResource);
export type AuditEventAppendInput = z.infer<typeof AuditEventAppendInputSchema>;

export type AuditEventAppenderOptions = {
  /** Caller supplies an ID so transaction callers and tests retain deterministic control. */
  readonly id: string;
  /** Caller supplies the clock; production integrations pass their trusted clock. */
  readonly now: () => Date;
};

/**
 * Narrow structural interface intentionally accepted by PrismaClient and an
 * interactive Prisma transaction alike. No transaction is opened here.
 */
export interface AuditEventRepository {
  readonly auditEvent: {
    create(input: { readonly data: AuditEventWrite }): Promise<unknown>;
  };
}

/** SHA-256 is the only permitted representation of a raw idempotency key here. */
export function fingerprintIdempotencyKey(value: string): z.infer<typeof IdempotencyKeyFingerprintSchema> {
  const key = IdempotencyKeySchema.parse(value);
  return IdempotencyKeyFingerprintSchema.parse(
    createHash("sha256").update(key, "utf8").digest("hex")
  );
}

/**
 * Appends one immutable audit event through the supplied repository. It is
 * safe to call inside an existing Prisma transaction because it does not open
 * or commit a transaction itself.
 */
export async function appendAuditEvent(
  repository: AuditEventRepository,
  input: unknown,
  options: AuditEventAppenderOptions
): Promise<AuditEvent> {
  const event = AuditEventAppendInputSchema.parse(input);
  const write = AuditEventWriteSchema.parse({
    id: options.id,
    tenantId: event.tenantId,
    action: event.action,
    principalKind: event.principal.kind,
    principalSubject: event.principal.subjectId,
    principalCredentialId: event.principal.credentialId,
    requestId: event.requestId,
    idempotencyKeyFingerprint:
      event.idempotencyKey === undefined ? null : fingerprintIdempotencyKey(event.idempotencyKey),
    resourceKind: event.resourceKind,
    resourceId: event.resourceId,
    occurredAt: options.now(),
  });
  return AuditEventSchema.parse(await repository.auditEvent.create({ data: write }));
}
