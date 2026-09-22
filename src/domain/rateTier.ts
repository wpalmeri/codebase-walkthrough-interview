export interface RateTier {
  upTo: number | null;
  unitPrice: number;
  floor?: number | null;
  ceiling?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid rate tier ${field}`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === null || value === undefined) return value;
  return requiredNumber(value, field);
}

export function parseRateTiers(value: unknown): RateTier[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Rate tiers must be an array");

  return value.map((tier, index) => {
    if (!isRecord(tier)) throw new Error(`Rate tier ${index} must be an object`);
    return {
      upTo: optionalNumber(tier.upTo, `${index}.upTo`) ?? null,
      unitPrice: requiredNumber(tier.unitPrice, `${index}.unitPrice`),
      floor: optionalNumber(tier.floor, `${index}.floor`),
      ceiling: optionalNumber(tier.ceiling, `${index}.ceiling`),
    };
  });
}
