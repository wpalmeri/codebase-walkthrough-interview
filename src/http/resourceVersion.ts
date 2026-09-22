import { z } from "zod";

/** Resource kinds eligible for optimistic concurrency once their routes opt in. */
export const ResourceKindSchema = z.enum(["customer", "product", "rate", "combo-discount", "order", "invoice"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;

export const ResourceVersionTargetSchema = z.strictObject({
  kind: ResourceKindSchema,
  id: z.string().min(1).max(512),
  version: ResourceVersionSchema,
});
export type ResourceVersionTarget = z.infer<typeof ResourceVersionTargetSchema>;

const OpaqueEtagSchema = z.string().max(2048).regex(/^"rv1_[A-Za-z0-9_-]+"$/u);
const OpaqueTagPayloadSchema = z.strictObject({
  kind: ResourceKindSchema,
  id: z.string().min(1).max(512),
  version: ResourceVersionSchema,
});

const PreconditionFailureCodeSchema = z.enum([
  "PRECONDITION_REQUIRED",
  "IF_MATCH_MALFORMED",
  "ETAG_RESOURCE_MISMATCH",
  "ETAG_VERSION_MISMATCH",
  "RESOURCE_VERSION_UNAVAILABLE",
]);
export type PreconditionFailureCode = z.infer<typeof PreconditionFailureCodeSchema>;

export const ResourceVersionPreconditionFailureSchema = z.strictObject({
  ok: z.literal(false),
  status: z.union([z.literal(400), z.literal(412), z.literal(428)]),
  code: PreconditionFailureCodeSchema,
  detail: z.string().min(1),
});
export type ResourceVersionPreconditionFailure = z.infer<typeof ResourceVersionPreconditionFailureSchema>;

export const ResourceVersionPreconditionSuccessSchema = z.strictObject({
  ok: z.literal(true),
  version: ResourceVersionSchema,
});
export type ResourceVersionPreconditionSuccess = z.infer<typeof ResourceVersionPreconditionSuccessSchema>;

export const ResourceVersionPreconditionResultSchema = z.discriminatedUnion("ok", [
  ResourceVersionPreconditionFailureSchema,
  ResourceVersionPreconditionSuccessSchema,
]);
export type ResourceVersionPreconditionResult = z.infer<typeof ResourceVersionPreconditionResultSchema>;

/**
 * Formats a strong, opaque version tag. Its JSON payload is base64url encoded
 * rather than exposed as API syntax; parsing always binds it back to the exact
 * resource kind and id, so a tag cannot be replayed against another resource.
 */
export function formatResourceEtag(target: ResourceVersionTarget): string {
  const parsed = ResourceVersionTargetSchema.parse(target);
  const opaquePayload = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  return `"rv1_${opaquePayload}"`;
}

/** Decodes a single strong resource ETag. HTTP lists, wildcard and weak tags are intentionally unsupported. */
export function parseResourceEtag(value: string): ResourceVersionTarget | undefined {
  const parsedTag = OpaqueEtagSchema.safeParse(value.trim());
  if (!parsedTag.success) return undefined;

  const encoded = parsedTag.data.slice('"rv1_'.length, -1);
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const payload = OpaqueTagPayloadSchema.safeParse(JSON.parse(decoded));
    if (!payload.success) return undefined;

    // Buffer's decoder accepts a few noncanonical inputs. Re-encoding keeps
    // the accepted representation singular and makes tag comparisons stable.
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) return undefined;
    return payload.data;
  } catch {
    return undefined;
  }
}

/**
 * Validates the exact If-Match condition before a controller performs its
 * compare-and-swap update. It returns public, stable problem metadata so the
 * HTTP boundary can render it without interpreting parser implementation.
 */
export function verifyResourceIfMatch(
  ifMatch: string | undefined,
  target: Pick<ResourceVersionTarget, "kind" | "id">,
  currentVersion: number | null
): ResourceVersionPreconditionResult {
  const parsedTarget = ResourceVersionTargetSchema.safeParse({ ...target, version: 0 });
  if (!parsedTarget.success) {
    return failure(400, "IF_MATCH_MALFORMED", "The target resource identifier is invalid");
  }
  if (ifMatch === undefined || ifMatch.trim().length === 0) {
    return failure(428, "PRECONDITION_REQUIRED", "If-Match is required for this write");
  }

  const supplied = parseResourceEtag(ifMatch);
  if (supplied === undefined) {
    return failure(400, "IF_MATCH_MALFORMED", "If-Match must contain one supported strong resource ETag");
  }
  if (supplied.kind !== target.kind || supplied.id !== target.id) {
    return failure(412, "ETAG_RESOURCE_MISMATCH", "If-Match belongs to a different resource");
  }
  if (currentVersion === null || !ResourceVersionSchema.safeParse(currentVersion).success) {
    return failure(412, "RESOURCE_VERSION_UNAVAILABLE", "This resource is not yet versioned for conditional writes");
  }
  if (supplied.version !== currentVersion) {
    return failure(412, "ETAG_VERSION_MISMATCH", "If-Match does not match the current resource version");
  }
  return { ok: true, version: supplied.version };
}

function failure(
  status: ResourceVersionPreconditionFailure["status"],
  code: PreconditionFailureCode,
  detail: string
): ResourceVersionPreconditionFailure {
  return { ok: false, status, code, detail };
}
