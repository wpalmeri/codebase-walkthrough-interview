import { z } from "zod";

/** Pagination intentionally accepts at most one hundred rows per request. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export const ResourceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const FilterFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const CursorValueSchema = z.union([
  z.string().min(1).max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const OrderingTupleSchema = z.array(CursorValueSchema).min(1).max(8);

export type CursorValue = z.infer<typeof CursorValueSchema>;
export type OrderingTuple = z.infer<typeof OrderingTupleSchema>;

/**
 * This is deliberately limited to public query-filter primitives. A controller
 * supplies only its normalized public filters. The resulting fingerprint is
 * global because this is one company-owned billing system.
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

export const CursorPayloadSchema = z.strictObject({
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
