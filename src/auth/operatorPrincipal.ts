import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { AuthenticationError } from "../errors";
import { PrincipalSchema, type Principal } from "./principal";

const BearerTokenSchema = z.string().min(1).max(512).regex(/^mrd_[A-Za-z0-9]{8,32}_[A-Za-z0-9-]{32,128}$/u);
const OperatorApiKeyTokenSchema = z.string().regex(/^mrd_(?<prefix>[A-Za-z0-9]{8,32})_(?<secret>[A-Za-z0-9-]{32,128})$/u);
const KeyHashSchema = z.string().regex(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
export const ApiKeyPepperSchema = z
  .string()
  .min(32, "MERIDIAN_API_KEY_PEPPER must be at least 32 characters")
  .refine((value) => Buffer.byteLength(value, "utf8") >= 32, "MERIDIAN_API_KEY_PEPPER must be at least 32 bytes");

export type OperatorApiKeyRecord = {
  readonly id: string;
  readonly role: "ADMIN" | "BILLING" | "VIEWER";
  readonly keyHash: string;
  readonly revokedAt: Date | null;
};

export interface OperatorApiKeyReader {
  findByPrefix(keyPrefix: string): Promise<OperatorApiKeyRecord | null>;
}

export interface OperatorPrincipalResolver {
  resolve(token: string): Promise<Principal | null>;
}

export function bearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^Bearer ([^\s]+)$/u.exec(value)?.[1] ?? null;
}

export function apiKeyHash(token: string, pepper: string): string {
  const validatedPepper = ApiKeyPepperSchema.parse(pepper);
  return `hmac-sha256:v1:${createHmac("sha256", validatedPepper).update(token).digest("hex")}`;
}

function parsedKeyPrefix(token: string): string | null {
  if (!OperatorApiKeyTokenSchema.safeParse(token).success) return null;
  const prefix = /^mrd_(?<prefix>[A-Za-z0-9]{8,32})_/u.exec(token)?.groups?.prefix;
  return prefix === undefined ? null : `mrd_${prefix}`;
}

function constantTimeHashMatch(candidate: string, stored: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const storedBytes = Buffer.from(stored);
  return candidateBytes.length === storedBytes.length && timingSafeEqual(candidateBytes, storedBytes);
}

/** Resolves a strict opaque operator credential without retaining its secret. */
export function createOperatorPrincipalResolver(reader: OperatorApiKeyReader, pepper: string): OperatorPrincipalResolver {
  const validatedPepper = ApiKeyPepperSchema.safeParse(pepper);
  if (!validatedPepper.success) throw new Error("MERIDIAN_API_KEY_PEPPER must be at least 32 characters");
  return {
    async resolve(token) {
      if (!BearerTokenSchema.safeParse(token).success) return null;
      const keyPrefix = parsedKeyPrefix(token);
      if (keyPrefix === null) return null;
      const record = await reader.findByPrefix(keyPrefix);
      if (record === null || record.revokedAt !== null) return null;
      const storedHash = KeyHashSchema.safeParse(record.keyHash);
      if (!storedHash.success || !constantTimeHashMatch(apiKeyHash(token, validatedPepper.data), storedHash.data)) return null;
      return PrincipalSchema.parse({
        subjectId: `operator:${record.id}`,
        credentialId: record.id,
        kind: "OPERATOR_API_KEY",
        role: record.role,
      });
    },
  };
}

export function createPrismaOperatorPrincipalResolver(pepper: string): OperatorPrincipalResolver {
  return createOperatorPrincipalResolver(
    {
      async findByPrefix(keyPrefix) {
        return prisma.operatorApiKey.findUnique({
          where: { keyPrefix },
          select: { id: true, role: true, keyHash: true, revokedAt: true },
        });
      },
    },
    pepper
  );
}

function tokensMatch(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

export type AuthenticationOptions = {
  readonly environment: string;
  readonly legacyApiKey: string;
  readonly principalResolver?: OperatorPrincipalResolver;
};

const legacyPrincipal = PrincipalSchema.parse({
  subjectId: "legacy:meridian-api",
  credentialId: "legacy:meridian-api",
  kind: "LEGACY_API_KEY",
  role: "ADMIN",
});

const developmentPrincipal = PrincipalSchema.parse({
  subjectId: "development:unauthenticated",
  credentialId: "development:unauthenticated",
  kind: "DEVELOPMENT",
  role: "ADMIN",
});

/** Authenticates server-configured or stored global operator credentials. */
export function createAuthenticationMiddleware(options: AuthenticationOptions): RequestHandler {
  return (request, response, next) => {
    const token = bearerToken(request.get("authorization"));
    if (token === null) {
      if (options.legacyApiKey.length === 0 && options.environment !== "production") {
        request.principal = developmentPrincipal;
        next();
        return;
      }
      response.set("WWW-Authenticate", 'Bearer realm="meridian-api"');
      next(new AuthenticationError());
      return;
    }
    if (options.legacyApiKey.length > 0 && tokensMatch(token, options.legacyApiKey)) {
      request.principal = legacyPrincipal;
      next();
      return;
    }
    if (options.principalResolver === undefined) {
      response.set("WWW-Authenticate", 'Bearer realm="meridian-api"');
      next(new AuthenticationError());
      return;
    }
    void options.principalResolver.resolve(token).then(
      (principal) => {
        if (principal === null) {
          response.set("WWW-Authenticate", 'Bearer realm="meridian-api"');
          next(new AuthenticationError());
          return;
        }
        request.principal = PrincipalSchema.parse(principal);
        next();
      },
      next
    );
  };
}
