import { createHash } from "node:crypto";
import { z } from "zod";

/** Pagination intentionally accepts at most one hundred rows per request. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

const ResourceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const FilterFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CursorValueSchema = z.union([
  z.string().min(1).max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const OrderingTupleSchema = z.array(CursorValueSchema).min(1).max(8);

export type CursorValue = z.infer<typeof CursorValueSchema>;
export type OrderingTuple = z.infer<typeof OrderingTupleSchema>;

/**
 * This is deliberately limited to public query-filter primitives. A controller
 * supplies only its normalized, tenant-agnostic filters; tenant identity comes
 * from authentication and is never placed in a cursor.
 */
export const PaginationFilterValueSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type PaginationFilterValue = z.infer<typeof PaginationFilterValueSchema>;

const PaginationFilterKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/u);
export const PaginationFiltersSchema = z.record(
  PaginationFilterKeySchema,
  PaginationFilterValueSchema.optional()
);
export type PaginationFilters = z.infer<typeof PaginationFiltersSchema>;

const LimitInputSchema = z
  .union([
    z.number().int(),
    z.string().regex(/^[1-9][0-9]*$/u).transform(Number),
  ])
  .pipe(z.number().int().min(1).max(MAX_PAGE_LIMIT));

export const PaginationQuerySchema = z.strictObject({
  limit: LimitInputSchema.default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(2_048).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginationCursorInputSchema = z.strictObject({
  resource: ResourceNameSchema,
  filterFingerprint: FilterFingerprintSchema,
  ordering: OrderingTupleSchema,
});
export type PaginationCursorInput = z.infer<typeof PaginationCursorInputSchema>;

const CursorPayloadSchema = z.strictObject({
  v: z.number().int(),
  r: ResourceNameSchema,
  f: FilterFingerprintSchema,
  o: OrderingTupleSchema,
});

export const PaginationCursorFailureCodeSchema = z.enum([
  "CURSOR_MALFORMED",
  "CURSOR_UNSUPPORTED_VERSION",
  "CURSOR_RESOURCE_MISMATCH",
  "CURSOR_FILTER_MISMATCH",
]);
export type PaginationCursorFailureCode = z.infer<
  typeof PaginationCursorFailureCodeSchema
>;

export const PaginationCursorFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: PaginationCursorFailureCodeSchema,
});
export type PaginationCursorFailure = z.infer<typeof PaginationCursorFailureSchema>;

export const PaginationCursorSuccessSchema = z.strictObject({
  ok: z.literal(true),
  ordering: OrderingTupleSchema,
});
export type PaginationCursorSuccess = z.infer<typeof PaginationCursorSuccessSchema>;

export const PaginationCursorResultSchema = z.discriminatedUnion("ok", [
  PaginationCursorFailureSchema,
  PaginationCursorSuccessSchema,
]);
export type PaginationCursorResult = z.infer<typeof PaginationCursorResultSchema>;

export const PageMetadataSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT),
  nextCursor: z.string().min(1).max(2_048).nullable(),
});
export type PageMetadata = z.infer<typeof PageMetadataSchema>;

/** Builds a strict additive response envelope for any paginated resource. */
export function PageEnvelopeSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    data: z.array(item),
    page: PageMetadataSchema,
  });
}

export type PageEnvelope<Item> = {
  data: Item[];
  page: PageMetadata;
};

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
