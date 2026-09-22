import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CursorPayloadSchema,
  FilterFingerprintSchema,
  PaginationCursorInputSchema,
  type PaginationCursorFailure,
  type PaginationCursorFailureCode,
  type PaginationCursorInput,
  type PaginationCursorResult,
  PaginationFiltersSchema,
  type PaginationFilters,
  ResourceNameSchema,
} from "./paginationSchemas.js";

export * from "./paginationSchemas.js";

/**
 * Produces a stable SHA-256 fingerprint of normalized public filters. Undefined
 * filters are omitted, so `{ customerId: undefined }` and `{}` share a cursor.
 */
export function fingerprintPaginationFilters(filters: PaginationFilters): string {
  const normalized = Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
  );
  const validated = PaginationFiltersSchema.parse(normalized);
  return createHash("sha256").update(JSON.stringify(validated), "utf8").digest("hex");
}

/** Formats the sole canonical representation of a version-one opaque cursor. */
export function formatPaginationCursor(input: PaginationCursorInput): string {
  const parsed = PaginationCursorInputSchema.parse(input);
  const payload = { v: 1, r: parsed.resource, f: parsed.filterFingerprint, o: parsed.ordering };
  return `pc1_${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

/**
 * Parses a cursor and binds it to the current resource and visible filter set.
 * The result deliberately has stable public codes, rather than decoder errors.
 */
export function parsePaginationCursor(
  cursor: string,
  binding: Pick<PaginationCursorInput, "resource" | "filterFingerprint">
): PaginationCursorResult {
  const expected = z
    .strictObject({
      resource: ResourceNameSchema,
      filterFingerprint: FilterFingerprintSchema,
    })
    .parse(binding);

  if (!/^pc1_[A-Za-z0-9_-]{1,2044}$/u.test(cursor)) {
    return cursorFailure("CURSOR_MALFORMED");
  }

  const encoded = cursor.slice("pc1_".length);
  let decoded: string;
  let parsedPayload: z.infer<typeof CursorPayloadSchema>;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const rawPayload: unknown = JSON.parse(decoded);
    const result = CursorPayloadSchema.safeParse(rawPayload);
    if (!result.success) return cursorFailure("CURSOR_MALFORMED");
    parsedPayload = result.data;
  } catch {
    return cursorFailure("CURSOR_MALFORMED");
  }

  // Buffer is permissive and JSON permits whitespace/key reordering. Compare
  // both canonical forms so equivalent values have exactly one accepted cursor.
  const canonicalPayload = JSON.stringify(parsedPayload);
  if (
    decoded !== canonicalPayload ||
    Buffer.from(decoded, "utf8").toString("base64url") !== encoded
  ) {
    return cursorFailure("CURSOR_MALFORMED");
  }
  if (parsedPayload.v !== 1) return cursorFailure("CURSOR_UNSUPPORTED_VERSION");
  if (parsedPayload.r !== expected.resource) return cursorFailure("CURSOR_RESOURCE_MISMATCH");
  if (parsedPayload.f !== expected.filterFingerprint) {
    return cursorFailure("CURSOR_FILTER_MISMATCH");
  }

  return { ok: true, ordering: parsedPayload.o };
}

function cursorFailure(code: PaginationCursorFailureCode): PaginationCursorFailure {
  return { ok: false, code };
}
