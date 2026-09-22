import { randomBytes } from "node:crypto";
import { TenantApiKeyIdSchema } from "@meridian/contracts";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  appendRequestAuditEvent,
  RequestAuditMetadataSchema,
  type RequestAuditAppender,
  type RequestAuditMetadata,
} from "../audit/requestAudit";
import { type Principal } from "./principal";
import { apiKeyHash, ApiKeyPepperSchema } from "./tenantPrincipal";
import { PrincipalRoleSchema, TenantIdSchema } from "./principal";

const KeyPrefixSchema = z.string().regex(/^mrd_[A-Za-z0-9]{8,32}$/u);
const OpaqueTokenSchema = z.string().regex(/^mrd_[A-Za-z0-9]{8,32}_[A-Za-z0-9-]{32,128}$/u);
const KeyIdSchema = TenantApiKeyIdSchema;
const KeyNameSchema = z.string().trim().min(1).max(160);

export const IssueTenantApiKeyInputSchema = z
  .object({
    tenantId: TenantIdSchema,
    name: KeyNameSchema,
    role: PrincipalRoleSchema,
  })
  .strict();
export type IssueTenantApiKeyInput = z.infer<typeof IssueTenantApiKeyInputSchema>;

export const RevokeTenantApiKeyInputSchema = z
  .object({
    keyId: KeyIdSchema.optional(),
    keyPrefix: KeyPrefixSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.keyId === undefined) === (value.keyPrefix === undefined)) {
      context.addIssue({ code: "custom", message: "provide exactly one of keyId or keyPrefix" });
    }
  });
export type RevokeTenantApiKeyInput = z.infer<typeof RevokeTenantApiKeyInputSchema>;

const IssuedTenantApiKeySchema = z
  .object({
    id: KeyIdSchema,
    tenantId: TenantIdSchema,
    name: KeyNameSchema,
    role: PrincipalRoleSchema,
    keyPrefix: KeyPrefixSchema,
    createdAt: z.coerce.date(),
    /** Deliberately ephemeral: callers must communicate it directly to the operator. */
    token: OpaqueTokenSchema,
  })
  .strict();
export type IssuedTenantApiKey = z.infer<typeof IssuedTenantApiKeySchema>;

export const RevokeTenantApiKeyResultSchema = z
  .object({
    id: KeyIdSchema,
    tenantId: TenantIdSchema,
    keyPrefix: KeyPrefixSchema,
    state: z.enum(["REVOKED", "ALREADY_REVOKED"]),
    revokedAt: z.coerce.date(),
  })
  .strict();
export type RevokeTenantApiKeyResult = z.infer<typeof RevokeTenantApiKeyResultSchema>;

type TenantApiKeyRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly role: "ADMIN" | "BILLING" | "VIEWER";
  readonly keyPrefix: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
};

export interface TenantApiKeyLifecycleStore {
  readonly tenant: {
    findUnique(input: { readonly where: { readonly id: string }; readonly select: { readonly id: true } }): Promise<{ id: string } | null>;
  };
  readonly tenantApiKey: {
    create(input: {
      readonly data: {
        readonly tenantId: string;
        readonly name: string;
        readonly role: "ADMIN" | "BILLING" | "VIEWER";
        readonly keyPrefix: string;
        readonly keyHash: string;
      };
      readonly select: {
        readonly id: true;
        readonly tenantId: true;
        readonly name: true;
        readonly role: true;
        readonly keyPrefix: true;
        readonly createdAt: true;
      };
    }): Promise<Omit<TenantApiKeyRow, "revokedAt">>;
    findUnique(input: {
      readonly where: { readonly id: string } | { readonly keyPrefix: string };
      readonly select: {
        readonly id: true;
        readonly tenantId: true;
        readonly name: true;
        readonly role: true;
        readonly keyPrefix: true;
        readonly createdAt: true;
        readonly revokedAt: true;
      };
    }): Promise<TenantApiKeyRow | null>;
    updateMany(input: { readonly where: { readonly id: string; readonly revokedAt: null }; readonly data: { readonly revokedAt: Date } }): Promise<{ count: number }>;
  };
}

export class TenantApiKeyLifecycleError extends Error {
  constructor(
    readonly code: "TENANT_NOT_FOUND" | "KEY_NAME_CONFLICT" | "KEY_NOT_FOUND" | "KEY_PREFIX_COLLISION",
    message: string
  ) {
    super(message);
    this.name = "TenantApiKeyLifecycleError";
  }
}

function generatedToken(): string {
  // Hex is restricted to the resolver's conservative token grammar. The prefix
  // is an operator-facing lookup hint; the random secret is never stored.
  return `mrd_${randomBytes(12).toString("hex")}_${randomBytes(32).toString("hex")}`;
}

function tokenPrefix(token: string): string {
  const parsed = OpaqueTokenSchema.parse(token);
  const prefix = /^mrd_([A-Za-z0-9]{8,32})_/u.exec(parsed)?.[1];
  if (prefix === undefined) throw new Error("generated tenant API key has no prefix");
  return `mrd_${prefix}`;
}

function isUniqueConstraint(error: unknown, field: "name" | "keyPrefix" | "keyHash"): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  if (!Array.isArray(target)) return false;
  if (field === "name") return target.includes("tenantId") && target.includes("name");
  return target.includes(field);
}

function stableCreateError(error: unknown): TenantApiKeyLifecycleError | undefined {
  if (isUniqueConstraint(error, "name")) {
    return new TenantApiKeyLifecycleError("KEY_NAME_CONFLICT", "a tenant API key already uses this name");
  }
  return undefined;
}

export type IssueTenantApiKeyOptions = {
  readonly maxPrefixAttempts?: number;
  readonly tokenGenerator?: () => string;
};

/**
 * Generates a tenant credential without ever persisting its plaintext secret.
 * The returned token is the one and only opportunity for a caller to disclose it.
 */
export async function issueTenantApiKey(
  store: TenantApiKeyLifecycleStore,
  input: unknown,
  pepper: string,
  options: IssueTenantApiKeyOptions = {}
): Promise<IssuedTenantApiKey> {
  const validatedInput = IssueTenantApiKeyInputSchema.parse(input);
  const validatedPepper = ApiKeyPepperSchema.parse(pepper);
  const maxPrefixAttempts = z.number().int().min(1).max(20).parse(options.maxPrefixAttempts ?? 5);
  const tenant = await store.tenant.findUnique({ where: { id: validatedInput.tenantId }, select: { id: true } });
  if (tenant === null) throw new TenantApiKeyLifecycleError("TENANT_NOT_FOUND", "tenant does not exist");

  const generate = options.tokenGenerator ?? generatedToken;
  for (let attempt = 0; attempt < maxPrefixAttempts; attempt += 1) {
    const token = OpaqueTokenSchema.parse(generate());
    const keyPrefix = tokenPrefix(token);
    try {
      const created = await store.tenantApiKey.create({
        data: {
          tenantId: validatedInput.tenantId,
          name: validatedInput.name,
          role: validatedInput.role,
          keyPrefix,
          keyHash: apiKeyHash(token, validatedPepper),
        },
        select: { id: true, tenantId: true, name: true, role: true, keyPrefix: true, createdAt: true },
      });
      return IssuedTenantApiKeySchema.parse({ ...created, token });
    } catch (error) {
      const stable = stableCreateError(error);
      if (stable !== undefined) throw stable;
      // Prefix collisions are retried with a fresh credential. A hash collision
      // is treated equivalently, though it is cryptographically implausible.
      if (isUniqueConstraint(error, "keyPrefix") || isUniqueConstraint(error, "keyHash")) continue;
      throw error;
    }
  }
  throw new TenantApiKeyLifecycleError(
    "KEY_PREFIX_COLLISION",
    "could not allocate a unique tenant API key prefix after bounded retries"
  );
}

/** Revocation is monotonic and idempotent; a key can never be reactivated here. */
export async function revokeTenantApiKey(
  store: TenantApiKeyLifecycleStore,
  input: unknown,
  now: () => Date = () => new Date()
): Promise<RevokeTenantApiKeyResult> {
  const validatedInput = RevokeTenantApiKeyInputSchema.parse(input);
  const where = validatedInput.keyId === undefined ? { keyPrefix: validatedInput.keyPrefix! } : { id: validatedInput.keyId };
  const existing = await store.tenantApiKey.findUnique({
    where,
    select: { id: true, tenantId: true, name: true, role: true, keyPrefix: true, createdAt: true, revokedAt: true },
  });
  if (existing === null) throw new TenantApiKeyLifecycleError("KEY_NOT_FOUND", "tenant API key does not exist");
  if (existing.revokedAt !== null) {
    return RevokeTenantApiKeyResultSchema.parse({
      id: existing.id,
      tenantId: existing.tenantId,
      keyPrefix: existing.keyPrefix,
      state: "ALREADY_REVOKED",
      revokedAt: existing.revokedAt,
    });
  }

  const revokedAt = now();
  const updated = await store.tenantApiKey.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt } });
  if (updated.count === 1) {
    return RevokeTenantApiKeyResultSchema.parse({
      id: existing.id,
      tenantId: existing.tenantId,
      keyPrefix: existing.keyPrefix,
      state: "REVOKED",
      revokedAt,
    });
  }

  // A concurrent operator revoked it after our read. Reload to make the race
  // idempotent rather than overwriting a revocation timestamp.
  const raced = await store.tenantApiKey.findUnique({
    where: { id: existing.id },
    select: { id: true, tenantId: true, name: true, role: true, keyPrefix: true, createdAt: true, revokedAt: true },
  });
  if (raced !== null && raced.revokedAt !== null) {
    return RevokeTenantApiKeyResultSchema.parse({
      id: raced.id,
      tenantId: raced.tenantId,
      keyPrefix: raced.keyPrefix,
      state: "ALREADY_REVOKED",
      revokedAt: raced.revokedAt,
    });
  }
  throw new TenantApiKeyLifecycleError("KEY_NOT_FOUND", "tenant API key does not exist");
}

export const TenantApiKeyCliCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), input: IssueTenantApiKeyInputSchema }).strict(),
  z.object({ action: z.literal("revoke"), input: RevokeTenantApiKeyInputSchema }).strict(),
]);
export type TenantApiKeyCliCommand = z.infer<typeof TenantApiKeyCliCommandSchema>;

export const TenantApiKeyCliResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issued"), key: IssuedTenantApiKeySchema }).strict(),
  z.object({ action: z.literal("revoked"), key: RevokeTenantApiKeyResultSchema }).strict(),
]);
export type TenantApiKeyCliResult = z.infer<typeof TenantApiKeyCliResultSchema>;

/** Stable domain failures for the authenticated administration surface. */
export class TenantApiKeyAdministrationError extends Error {
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
    this.name = "TenantApiKeyAdministrationError";
  }
}

type AdminKeyRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly role: "ADMIN" | "BILLING" | "VIEWER";
  readonly keyPrefix: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
};

/** The deliberately narrow subset available within a single Prisma transaction. */
export interface TenantApiKeyAdministrationTransaction {
  readonly tenantApiKey: {
    findFirst(input: {
      readonly where: {
        readonly id?: string;
        readonly tenantId: string;
        readonly role?: "ADMIN";
        readonly revokedAt?: null;
        readonly keyPrefix?: string;
      };
      readonly select: Record<string, true>;
    }): Promise<AdminKeyRow | null>;
    create(input: {
      readonly data: {
        readonly tenantId: string;
        readonly name: string;
        readonly role: "ADMIN" | "BILLING" | "VIEWER";
        readonly keyPrefix: string;
        readonly keyHash: string;
      };
      readonly select: Record<string, true>;
    }): Promise<Omit<AdminKeyRow, "revokedAt">>;
    updateMany(input: {
      readonly where: { readonly id: string; readonly tenantId: string; readonly revokedAt: null };
      readonly data: { readonly revokedAt: Date };
    }): Promise<{ readonly count: number }>;
  };
  readonly auditEvent: {
    create(input: { readonly data: unknown }): Promise<unknown>;
  };
}

export interface TenantApiKeyAdministrationStore {
  $transaction<T>(operation: (transaction: TenantApiKeyAdministrationTransaction) => Promise<T>): Promise<T>;
}

export type IssueTenantApiKeyForAdminOptions = IssueTenantApiKeyOptions & {
  readonly now?: () => Date;
  readonly appendAudit?: RequestAuditAppender;
};

export type RevokeTenantApiKeyForAdminOptions = {
  readonly now?: () => Date;
  readonly appendAudit?: RequestAuditAppender;
};

function requireTenantApiKeyAdmin(principal: Principal): Principal {
  if (principal.kind !== "TENANT_API_KEY" || principal.role !== "ADMIN") {
    throw new TenantApiKeyAdministrationError(
      "ADMIN_API_KEY_REQUIRED",
      "tenant API-key administration requires an active ADMIN tenant API key"
    );
  }
  return principal;
}

async function revalidateActingAdmin(
  transaction: TenantApiKeyAdministrationTransaction,
  principal: Principal
): Promise<void> {
  const active = await transaction.tenantApiKey.findFirst({
    where: {
      id: principal.credentialId,
      tenantId: principal.tenantId,
      role: "ADMIN",
      revokedAt: null,
    },
    select: { id: true },
  });
  if (active === null) {
    throw new TenantApiKeyAdministrationError(
      "ACTING_KEY_NOT_ACTIVE",
      "the authenticated tenant API key is no longer active"
    );
  }
}

function isKeyPrefixOrHashCollision(error: unknown): boolean {
  return isUniqueConstraint(error, "keyPrefix") || isUniqueConstraint(error, "keyHash");
}

function requestAuditMetadataForActor(metadata: RequestAuditMetadata, actor: Principal): RequestAuditMetadata {
  const parsed = RequestAuditMetadataSchema.parse(metadata);
  if (
    parsed.tenantId !== actor.tenantId ||
    parsed.principal.kind !== actor.kind ||
    parsed.principal.subjectId !== actor.subjectId ||
    parsed.principal.credentialId !== actor.credentialId
  ) {
    throw new TenantApiKeyAdministrationError(
      "AUDIT_IDENTITY_MISMATCH",
      "audit identity must match the authenticated tenant API key"
    );
  }
  return parsed;
}

function isLastActiveAdminGuard(error: unknown): boolean {
  // Prisma's SQLite adapter currently collapses a trigger RAISE(ABORT) into
  // P2003 and discards the trigger message. This revoke path updates only
  // revokedAt, so that code can only be the final-admin trigger here.
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") ||
    (error instanceof Error && error.message.includes("tenant must retain an active ADMIN API key"))
  );
}

/**
 * Issues a tenant key and its immutable audit event in one transaction. The
 * plaintext token stays only in the returned in-memory response and is never
 * eligible for durable idempotency replay.
 */
export async function issueTenantApiKeyForAdmin(
  store: TenantApiKeyAdministrationStore,
  principal: Principal,
  input: unknown,
  metadata: RequestAuditMetadata,
  pepper: string,
  options: IssueTenantApiKeyForAdminOptions = {}
): Promise<IssuedTenantApiKey> {
  const actor = requireTenantApiKeyAdmin(principal);
  const body = z.object({ name: KeyNameSchema, role: PrincipalRoleSchema }).strict().parse(input);
  const audited = requestAuditMetadataForActor(metadata, actor);
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
        const key = await transaction.tenantApiKey.create({
          data: {
            tenantId: actor.tenantId,
            name: body.name,
            role: body.role,
            keyPrefix,
            keyHash: apiKeyHash(token, validatedPepper),
          },
          select: { id: true, tenantId: true, name: true, role: true, keyPrefix: true, createdAt: true },
        });
        await appendAudit(transaction, audited, {
          action: "TENANT_API_KEY_ISSUED",
          resourceKind: "TENANT_API_KEY",
          resourceId: key.id,
        }, { now: options.now });
        return key;
      });
      return IssuedTenantApiKeySchema.parse({ ...created, token });
    } catch (error) {
      if (isUniqueConstraint(error, "name")) {
        throw new TenantApiKeyAdministrationError("KEY_NAME_CONFLICT", "a tenant API key already uses this name");
      }
      if (isKeyPrefixOrHashCollision(error)) continue;
      throw error;
    }
  }
  throw new TenantApiKeyAdministrationError(
    "KEY_PREFIX_COLLISION",
    "could not allocate a unique tenant API key prefix after bounded retries"
  );
}

/** Revokes only an in-tenant key, then appends one audit event for the actual transition. */
export async function revokeTenantApiKeyForAdmin(
  store: TenantApiKeyAdministrationStore,
  principal: Principal,
  input: unknown,
  metadata: RequestAuditMetadata,
  options: RevokeTenantApiKeyForAdminOptions = {}
): Promise<RevokeTenantApiKeyResult> {
  const actor = requireTenantApiKeyAdmin(principal);
  const requested = RevokeTenantApiKeyInputSchema.parse(input);
  const audited = requestAuditMetadataForActor(metadata, actor);
  const appendAudit = options.appendAudit ?? appendRequestAuditEvent;
  const now = options.now ?? (() => new Date());

  try {
    return await store.$transaction(async (transaction) => {
      await revalidateActingAdmin(transaction, actor);
      const existing = await transaction.tenantApiKey.findFirst({
        where: {
          tenantId: actor.tenantId,
          ...(requested.keyId === undefined ? { keyPrefix: requested.keyPrefix! } : { id: requested.keyId }),
        },
        select: { id: true, tenantId: true, name: true, role: true, keyPrefix: true, createdAt: true, revokedAt: true },
      });
      if (existing === null) {
        throw new TenantApiKeyAdministrationError("KEY_NOT_FOUND", "tenant API key does not exist");
      }
      const key = existing;
      if (key.id === actor.credentialId) {
        throw new TenantApiKeyAdministrationError(
          "SELF_REVOCATION_NOT_ALLOWED",
          "an administrator cannot revoke the credential authorizing this request"
        );
      }
      if (key.revokedAt !== null) {
        return RevokeTenantApiKeyResultSchema.parse({
          id: key.id, tenantId: key.tenantId, keyPrefix: key.keyPrefix, state: "ALREADY_REVOKED", revokedAt: key.revokedAt,
        });
      }

      const revokedAt = now();
      const updated = await transaction.tenantApiKey.updateMany({
        where: { id: key.id, tenantId: actor.tenantId, revokedAt: null },
        data: { revokedAt },
      });
      if (updated.count === 0) {
        const raced = await transaction.tenantApiKey.findFirst({
          where: { id: key.id, tenantId: actor.tenantId },
          select: { id: true, tenantId: true, name: true, role: true, keyPrefix: true, createdAt: true, revokedAt: true },
        });
        if (raced !== null && raced.revokedAt !== null) {
          const revoked = raced;
          return RevokeTenantApiKeyResultSchema.parse({
            id: revoked.id, tenantId: revoked.tenantId, keyPrefix: revoked.keyPrefix, state: "ALREADY_REVOKED", revokedAt: revoked.revokedAt,
          });
        }
        throw new TenantApiKeyAdministrationError("KEY_NOT_FOUND", "tenant API key does not exist");
      }
      await appendAudit(transaction, audited, {
        action: "TENANT_API_KEY_REVOKED",
        resourceKind: "TENANT_API_KEY",
        resourceId: key.id,
      }, { now });
      return RevokeTenantApiKeyResultSchema.parse({
        id: key.id, tenantId: key.tenantId, keyPrefix: key.keyPrefix, state: "REVOKED", revokedAt,
      });
    });
  } catch (error) {
    if (isLastActiveAdminGuard(error)) {
      throw new TenantApiKeyAdministrationError(
        "LAST_ACTIVE_ADMIN_REQUIRED",
        "a tenant must retain at least one active ADMIN API key"
      );
    }
    throw error;
  }
}

/** Serializes only approved fields; an issued token occurs exactly once. */
export function serializeTenantApiKeyCliResult(result: TenantApiKeyCliResult): string {
  return JSON.stringify(TenantApiKeyCliResultSchema.parse(result));
}

export function parseTenantApiKeyCliCommand(argv: readonly string[]): TenantApiKeyCliCommand {
  const [action, ...arguments_] = argv;
  if (action !== "issue" && action !== "revoke") throw new Error("usage: tenant:key <issue|revoke> [flags]");
  if (arguments_.length % 2 !== 0) throw new Error("flags must have values");
  const fields: Record<string, string> = {};
  const permitted = action === "issue" ? new Set(["--tenant-id", "--name", "--role"]) : new Set(["--key-id", "--prefix"]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !permitted.has(flag) || fields[flag] !== undefined) {
      throw new Error("unknown, duplicate, or incomplete tenant:key flag");
    }
    fields[flag] = value;
  }
  return action === "issue"
    ? TenantApiKeyCliCommandSchema.parse({
        action,
        input: { tenantId: fields["--tenant-id"], name: fields["--name"], role: fields["--role"] },
      })
    : TenantApiKeyCliCommandSchema.parse({
        action,
        input: { keyId: fields["--key-id"], keyPrefix: fields["--prefix"] },
      });
}
