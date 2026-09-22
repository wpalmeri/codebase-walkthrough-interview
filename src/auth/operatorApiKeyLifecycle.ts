import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { OperatorApiKeyIdSchema, OperatorApiKeyRoleSchema } from "@meridian/contracts";
import { z } from "zod";
import {
  appendRequestAuditEvent,
  RequestAuditMetadataSchema,
  type RequestAuditAppender,
  type RequestAuditMetadata,
} from "../audit/requestAudit";
import type { Principal } from "./principal";
import { apiKeyHash, ApiKeyPepperSchema } from "./operatorPrincipal";

const KeyPrefixSchema = z.string().regex(/^mrd_[A-Za-z0-9]{8,32}$/u);
const OpaqueTokenSchema = z.string().regex(/^mrd_[A-Za-z0-9]{8,32}_[A-Za-z0-9-]{32,128}$/u);
const KeyNameSchema = z.string().trim().min(1).max(160);
const KeyIdSchema = OperatorApiKeyIdSchema;

export const IssueOperatorApiKeyInputSchema = z.object({ name: KeyNameSchema, role: OperatorApiKeyRoleSchema }).strict();
export type IssueOperatorApiKeyInput = z.infer<typeof IssueOperatorApiKeyInputSchema>;
export const BootstrapOperatorApiKeyInputSchema = z.object({ name: KeyNameSchema }).strict();
export type BootstrapOperatorApiKeyInput = z.infer<typeof BootstrapOperatorApiKeyInputSchema>;
export const RevokeOperatorApiKeyInputSchema = z
  .object({ keyId: KeyIdSchema.optional(), keyPrefix: KeyPrefixSchema.optional() })
  .strict()
  .superRefine((value, context) => {
    if ((value.keyId === undefined) === (value.keyPrefix === undefined)) {
      context.addIssue({ code: "custom", message: "provide exactly one of keyId or keyPrefix" });
    }
  });
export type RevokeOperatorApiKeyInput = z.infer<typeof RevokeOperatorApiKeyInputSchema>;

const IssuedOperatorApiKeySchema = z
  .object({
    id: KeyIdSchema,
    name: KeyNameSchema,
    role: OperatorApiKeyRoleSchema,
    keyPrefix: KeyPrefixSchema,
    createdAt: z.coerce.date(),
    token: OpaqueTokenSchema,
  })
  .strict();
export type IssuedOperatorApiKey = z.infer<typeof IssuedOperatorApiKeySchema>;

export const RevokeOperatorApiKeyResultSchema = z
  .object({
    id: KeyIdSchema,
    keyPrefix: KeyPrefixSchema,
    state: z.enum(["REVOKED", "ALREADY_REVOKED"]),
    revokedAt: z.coerce.date(),
  })
  .strict();
export type RevokeOperatorApiKeyResult = z.infer<typeof RevokeOperatorApiKeyResultSchema>;

type KeyRow = {
  readonly id: string;
  readonly name: string;
  readonly role: "ADMIN" | "BILLING" | "VIEWER";
  readonly keyPrefix: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
};

type OperatorKeyDelegate = {
  create(input: {
    readonly data: { readonly name: string; readonly role: KeyRow["role"]; readonly keyPrefix: string; readonly keyHash: string };
    readonly select: Record<string, true>;
  }): Promise<Omit<KeyRow, "revokedAt">>;
  findFirst(input: { readonly where: Record<string, unknown>; readonly select: Record<string, true> }): Promise<KeyRow | null>;
  updateMany(input: { readonly where: Record<string, unknown>; readonly data: { readonly revokedAt: Date } }): Promise<{ readonly count: number }>;
};

export interface OperatorApiKeyAdministrationTransaction {
  readonly operatorApiKey: OperatorKeyDelegate;
  readonly auditEvent: { create(input: { readonly data: unknown }): Promise<unknown> };
}

export interface OperatorApiKeyAdministrationStore {
  $transaction<T>(operation: (transaction: OperatorApiKeyAdministrationTransaction) => Promise<T>): Promise<T>;
}

export class OperatorApiKeyAdministrationError extends Error {
  constructor(
    readonly code:
      | "ADMIN_API_KEY_REQUIRED"
      | "ACTING_KEY_NOT_ACTIVE"
      | "AUDIT_IDENTITY_MISMATCH"
      | "KEY_NAME_CONFLICT"
      | "KEY_NOT_FOUND"
      | "KEY_PREFIX_COLLISION"
      | "SELF_REVOCATION_NOT_ALLOWED"
      | "LAST_ACTIVE_ADMIN_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "OperatorApiKeyAdministrationError";
  }
}

export type IssueOperatorApiKeyOptions = {
  readonly maxPrefixAttempts?: number;
  readonly tokenGenerator?: () => string;
  readonly now?: () => Date;
  readonly appendAudit?: RequestAuditAppender;
};
export type RevokeOperatorApiKeyOptions = { readonly now?: () => Date; readonly appendAudit?: RequestAuditAppender };

export interface OperatorApiKeyBootstrapTransaction {
  readonly operatorApiKey: {
    count(input: { readonly where: { readonly revokedAt: null } }): Promise<number>;
    create(input: {
      readonly data: { readonly name: string; readonly role: "ADMIN"; readonly keyPrefix: string; readonly keyHash: string };
      readonly select: Record<string, true>;
    }): Promise<Omit<KeyRow, "revokedAt">>;
  };
  readonly auditEvent: { create(input: { readonly data: unknown }): Promise<unknown> };
}

export interface OperatorApiKeyBootstrapStore {
  $transaction<T>(operation: (transaction: OperatorApiKeyBootstrapTransaction) => Promise<T>): Promise<T>;
}

function generatedToken(): string {
  return `mrd_${randomBytes(12).toString("hex")}_${randomBytes(32).toString("hex")}`;
}

function tokenPrefix(token: string): string {
  const parsed = OpaqueTokenSchema.parse(token);
  const prefix = /^mrd_([A-Za-z0-9]{8,32})_/u.exec(parsed)?.[1];
  if (prefix === undefined) throw new Error("generated operator API key has no prefix");
  return `mrd_${prefix}`;
}

function isUniqueConstraint(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  if (field === undefined) return true;
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes(field);
}

function requireOperatorAdmin(principal: Principal): Principal {
  if (principal.kind !== "OPERATOR_API_KEY" || principal.role !== "ADMIN") {
    throw new OperatorApiKeyAdministrationError("ADMIN_API_KEY_REQUIRED", "operator API-key administration requires an active ADMIN key");
  }
  return principal;
}

function auditForActor(metadata: RequestAuditMetadata, actor: Principal): RequestAuditMetadata {
  const parsed = RequestAuditMetadataSchema.parse(metadata);
  if (
    parsed.principal.kind !== actor.kind ||
    parsed.principal.subjectId !== actor.subjectId ||
    parsed.principal.credentialId !== actor.credentialId
  ) {
    throw new OperatorApiKeyAdministrationError("AUDIT_IDENTITY_MISMATCH", "audit identity must match the authenticated operator key");
  }
  return parsed;
}

async function revalidateActingAdmin(transaction: OperatorApiKeyAdministrationTransaction, actor: Principal): Promise<void> {
  const active = await transaction.operatorApiKey.findFirst({
    where: { id: actor.credentialId, role: "ADMIN", revokedAt: null },
    select: { id: true },
  });
  if (active === null) throw new OperatorApiKeyAdministrationError("ACTING_KEY_NOT_ACTIVE", "the authenticated operator key is no longer active");
}

function isLastActiveAdminGuard(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") ||
    (error instanceof Error && error.message.includes("system must retain an active ADMIN API key"))
  );
}

/**
 * Creates the first global ADMIN credential. It intentionally refuses to add
 * a bypass credential once any active operator key exists; ordinary issuance
 * must then be performed through an authenticated ADMIN key and be audited.
 */
export async function bootstrapOperatorApiKey(
  store: OperatorApiKeyBootstrapStore,
  input: unknown,
  pepper: string,
  options: Pick<IssueOperatorApiKeyOptions, "maxPrefixAttempts" | "tokenGenerator"> = {}
): Promise<IssuedOperatorApiKey> {
  const body = BootstrapOperatorApiKeyInputSchema.parse(input);
  const validatedPepper = ApiKeyPepperSchema.parse(pepper);
  const maxPrefixAttempts = z.number().int().min(1).max(20).parse(options.maxPrefixAttempts ?? 5);
  const generate = options.tokenGenerator ?? generatedToken;
  for (let attempt = 0; attempt < maxPrefixAttempts; attempt += 1) {
    const token = OpaqueTokenSchema.parse(generate());
    const keyPrefix = tokenPrefix(token);
    try {
      const created = await store.$transaction(async (transaction) => {
        if ((await transaction.operatorApiKey.count({ where: { revokedAt: null } })) !== 0) {
          throw new OperatorApiKeyAdministrationError("ACTING_KEY_NOT_ACTIVE", "bootstrap is allowed only when no active operator API key exists");
        }
        const key = await transaction.operatorApiKey.create({
          data: { name: body.name, role: "ADMIN", keyPrefix, keyHash: apiKeyHash(token, validatedPepper) },
          select: { id: true, name: true, role: true, keyPrefix: true, createdAt: true },
        });
        await appendRequestAuditEvent(
          transaction,
          RequestAuditMetadataSchema.parse({
            principal: {
              kind: "DEVELOPMENT",
              subjectId: "bootstrap:operator-key",
              credentialId: "bootstrap:operator-key",
            },
            requestId: "operator-key-bootstrap",
          }),
          { action: "OPERATOR_API_KEY_ISSUED", resourceKind: "OPERATOR_API_KEY", resourceId: key.id }
        );
        return key;
      });
      return IssuedOperatorApiKeySchema.parse({ ...created, token });
    } catch (error) {
      if (isUniqueConstraint(error, "name")) throw new OperatorApiKeyAdministrationError("KEY_NAME_CONFLICT", "an operator API key already uses this name");
      if (isUniqueConstraint(error, "keyPrefix") || isUniqueConstraint(error, "keyHash")) continue;
      throw error;
    }
  }
  throw new OperatorApiKeyAdministrationError("KEY_PREFIX_COLLISION", "could not allocate a unique operator API key prefix after bounded retries");
}

/** Issues an operator credential and its immutable audit event atomically. */
export async function issueOperatorApiKeyForAdmin(
  store: OperatorApiKeyAdministrationStore,
  principal: Principal,
  input: unknown,
  metadata: RequestAuditMetadata,
  pepper: string,
  options: IssueOperatorApiKeyOptions = {}
): Promise<IssuedOperatorApiKey> {
  const actor = requireOperatorAdmin(principal);
  const body = IssueOperatorApiKeyInputSchema.parse(input);
  const audited = auditForActor(metadata, actor);
  const validatedPepper = ApiKeyPepperSchema.parse(pepper);
  const maxPrefixAttempts = z.number().int().min(1).max(20).parse(options.maxPrefixAttempts ?? 5);
  const generate = options.tokenGenerator ?? generatedToken;
  const appendAudit = options.appendAudit ?? appendRequestAuditEvent;
  for (let attempt = 0; attempt < maxPrefixAttempts; attempt += 1) {
    const token = OpaqueTokenSchema.parse(generate());
    const keyPrefix = tokenPrefix(token);
    try {
      const created = await store.$transaction(async (transaction) => {
        await revalidateActingAdmin(transaction, actor);
        const key = await transaction.operatorApiKey.create({
          data: { name: body.name, role: body.role, keyPrefix, keyHash: apiKeyHash(token, validatedPepper) },
          select: { id: true, name: true, role: true, keyPrefix: true, createdAt: true },
        });
        await appendAudit(transaction, audited, {
          action: "OPERATOR_API_KEY_ISSUED",
          resourceKind: "OPERATOR_API_KEY",
          resourceId: key.id,
        }, { now: options.now });
        return key;
      });
      return IssuedOperatorApiKeySchema.parse({ ...created, token });
    } catch (error) {
      if (isUniqueConstraint(error, "name")) throw new OperatorApiKeyAdministrationError("KEY_NAME_CONFLICT", "an operator API key already uses this name");
      if (isUniqueConstraint(error, "keyPrefix") || isUniqueConstraint(error, "keyHash")) continue;
      throw error;
    }
  }
  throw new OperatorApiKeyAdministrationError("KEY_PREFIX_COLLISION", "could not allocate a unique operator API key prefix after bounded retries");
}

/** Revokes a global operator key and writes an audit event for an actual transition. */
export async function revokeOperatorApiKeyForAdmin(
  store: OperatorApiKeyAdministrationStore,
  principal: Principal,
  input: unknown,
  metadata: RequestAuditMetadata,
  options: RevokeOperatorApiKeyOptions = {}
): Promise<RevokeOperatorApiKeyResult> {
  const actor = requireOperatorAdmin(principal);
  const requested = RevokeOperatorApiKeyInputSchema.parse(input);
  const audited = auditForActor(metadata, actor);
  const now = options.now ?? (() => new Date());
  const appendAudit = options.appendAudit ?? appendRequestAuditEvent;
  try {
    return await store.$transaction(async (transaction) => {
      await revalidateActingAdmin(transaction, actor);
      const existing = await transaction.operatorApiKey.findFirst({
        where: requested.keyId === undefined ? { keyPrefix: requested.keyPrefix! } : { id: requested.keyId },
        select: { id: true, name: true, role: true, keyPrefix: true, createdAt: true, revokedAt: true },
      });
      if (existing === null) throw new OperatorApiKeyAdministrationError("KEY_NOT_FOUND", "operator API key does not exist");
      if (existing.id === actor.credentialId) throw new OperatorApiKeyAdministrationError("SELF_REVOCATION_NOT_ALLOWED", "an administrator cannot revoke its authorizing credential");
      if (existing.revokedAt !== null) return RevokeOperatorApiKeyResultSchema.parse({ id: existing.id, keyPrefix: existing.keyPrefix, state: "ALREADY_REVOKED", revokedAt: existing.revokedAt });
      const revokedAt = now();
      const updated = await transaction.operatorApiKey.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt } });
      if (updated.count === 0) {
        const raced = await transaction.operatorApiKey.findFirst({ where: { id: existing.id }, select: { id: true, name: true, role: true, keyPrefix: true, createdAt: true, revokedAt: true } });
        if (raced !== null && raced.revokedAt !== null) return RevokeOperatorApiKeyResultSchema.parse({ id: raced.id, keyPrefix: raced.keyPrefix, state: "ALREADY_REVOKED", revokedAt: raced.revokedAt });
        throw new OperatorApiKeyAdministrationError("KEY_NOT_FOUND", "operator API key does not exist");
      }
      await appendAudit(transaction, audited, { action: "OPERATOR_API_KEY_REVOKED", resourceKind: "OPERATOR_API_KEY", resourceId: existing.id }, { now });
      return RevokeOperatorApiKeyResultSchema.parse({ id: existing.id, keyPrefix: existing.keyPrefix, state: "REVOKED", revokedAt });
    });
  } catch (error) {
    if (isLastActiveAdminGuard(error)) throw new OperatorApiKeyAdministrationError("LAST_ACTIVE_ADMIN_REQUIRED", "the system must retain at least one active ADMIN API key");
    throw error;
  }
}

export const OperatorApiKeyCliCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bootstrap"), input: BootstrapOperatorApiKeyInputSchema }).strict(),
  z.object({ action: z.literal("revoke"), input: RevokeOperatorApiKeyInputSchema }).strict(),
]);
export type OperatorApiKeyCliCommand = z.infer<typeof OperatorApiKeyCliCommandSchema>;

export function parseOperatorApiKeyCliCommand(argv: readonly string[]): OperatorApiKeyCliCommand {
  const [action, ...arguments_] = argv;
  if (action !== "bootstrap" && action !== "revoke") throw new Error("usage: operator:key <bootstrap|revoke> [flags]");
  if (arguments_.length % 2 !== 0) throw new Error("flags must have values");
  const fields: Record<string, string> = {};
  const permitted = action === "bootstrap" ? new Set(["--name"]) : new Set(["--key-id", "--prefix"]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !permitted.has(flag) || fields[flag] !== undefined) throw new Error("unknown, duplicate, or incomplete operator:key flag");
    fields[flag] = value;
  }
  return action === "bootstrap"
    ? OperatorApiKeyCliCommandSchema.parse({ action, input: { name: fields["--name"] } })
    : OperatorApiKeyCliCommandSchema.parse({ action, input: { keyId: fields["--key-id"], keyPrefix: fields["--prefix"] } });
}
