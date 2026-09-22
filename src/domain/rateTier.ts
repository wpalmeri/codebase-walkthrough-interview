import { RateTierSchema, type RateTier } from "@meridian/contracts";

export type { RateTier } from "@meridian/contracts";

export function parseRateTiers(value: unknown): RateTier[] {
  if (value === null || value === undefined) return [];
  return RateTierSchema.array().parse(value);
}
