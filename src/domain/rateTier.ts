import {
  ExactRateTierSchema,
  MoneyStringSchema,
  QuantityStringSchema,
  RateTierSchema,
  type ExactRateTier,
  type RateTier,
} from "@meridian/contracts";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  canonicalMoney,
  canonicalQuantity,
  legacyNumber,
} from "./money";

export type { ExactRateTier, RateTier } from "@meridian/contracts";

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "tier unit price" } as const;
const quantityFormat = {
  scale: QUANTITY_SCALE,
  precision: QUANTITY_PRECISION,
  field: "tier quantity",
} as const;

const PersistedRateTierSchema = RateTierSchema.or(ExactRateTierSchema);
type PersistedRateTier = RateTier | ExactRateTier;

function legacyMoney(value: number | string | null | undefined): number | null | undefined {
  return typeof value === "string" ? legacyNumber(value, moneyFormat) : value;
}

function legacyQuantity(value: number | string | null): number | null {
  return typeof value === "string" ? legacyNumber(value, quantityFormat) : value;
}

function toLegacyRateTier(tier: PersistedRateTier): RateTier {
  const floor = legacyMoney(tier.floor);
  const ceiling = legacyMoney(tier.ceiling);
  return RateTierSchema.parse({
    upTo: legacyQuantity(tier.upTo),
    unitPrice: legacyMoney(tier.unitPrice),
    ...(floor === undefined ? {} : { floor }),
    ...(ceiling === undefined ? {} : { ceiling }),
  });
}

function canonicalOptionalMoney(value: number | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  return MoneyStringSchema.parse(canonicalMoney(value, "tier unit price"));
}

/**
 * Converts the legacy numeric tier representation to the exact JSON shape
 * persisted in Rate.tiers. Monetary values and quantities are strings so JSON
 * cannot turn a decimal into a binary float on a later read.
 */
export function serializeRateTiers(tiers: readonly RateTier[]): ExactRateTier[] {
  return tiers.map((tier) => {
    const floor = canonicalOptionalMoney(tier.floor);
    const ceiling = canonicalOptionalMoney(tier.ceiling);
    return ExactRateTierSchema.parse({
      upTo:
        tier.upTo === null
          ? null
          : QuantityStringSchema.parse(canonicalQuantity(tier.upTo, "tier quantity")),
      unitPrice: MoneyStringSchema.parse(canonicalMoney(tier.unitPrice, "tier unit price")),
      ...(floor === undefined ? {} : { floor }),
      ...(ceiling === undefined ? {} : { ceiling }),
    });
  });
}

export function parseRateTiers(value: unknown): RateTier[] {
  if (value === null || value === undefined) return [];
  return PersistedRateTierSchema.array().parse(value).map(toLegacyRateTier);
}
