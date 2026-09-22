import {
  PageEnvelopeSchema,
  type PageEnvelope,
  type PageMetadata,
} from "@meridian/contracts";
import { z } from "zod";

export * from "@meridian/contracts";

const RelativeRequestTargetSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.startsWith("/") && !value.startsWith("//") && !/[\r\n#]/u.test(value),
    "A relative request target is required"
  );

/**
 * Renders a next-page RFC 8288 Link value without accepting an external URL or
 * header control characters. Undefined means there is no following page.
 */
export function formatNextPageLink(
  requestTarget: string,
  nextCursor: string | null
): string | undefined {
  if (nextCursor === null) return undefined;
  const target = RelativeRequestTargetSchema.parse(requestTarget);
  const cursor = z.string().min(1).max(2_048).parse(nextCursor);
  const url = new URL(target, "https://pagination.invalid");
  url.searchParams.set("cursor", cursor);
  return `<${url.pathname}${url.search}>; rel="next"`;
}

/** Validates a complete page at the HTTP boundary before it is serialized. */
export function pageEnvelope<Item extends z.ZodType>(
  item: Item,
  data: z.input<Item>[],
  page: PageMetadata
): PageEnvelope<z.output<Item>> {
  return PageEnvelopeSchema(item).parse({ data, page });
}
