/**
 * The persistence boundary for exact financial values. Prisma Decimal values
 * are structurally DecimalLike, so this module deliberately does not depend on
 * a generated Prisma client at runtime.
 *
 * Values are accepted as decimal strings first, then Prisma Decimal-like
 * objects, and finally finite legacy numbers during the expand/contract
 * rollout. The output is always a fixed-scale decimal string. No conversion
 * silently rounds a value that would not fit the requested storage scale.
 */
export interface DecimalLike {
  toString(): string;
}

export type DecimalInput = string | number | bigint | DecimalLike;
export type CanonicalDecimal = string;

export interface DecimalFormat {
  /** Number of fractional decimal places required in the output. */
  readonly scale: number;
  /** Maximum significant decimal digits accepted by the persistence column. */
  readonly precision?: number;
  readonly field?: string;
}

export interface DecimalOrLegacyInput {
  /** The new Decimal field. When present, it always wins over the legacy float. */
  readonly decimal: DecimalInput | null | undefined;
  /** Temporary compatibility field; only consulted while decimal is absent. */
  readonly legacy: number | null | undefined;
}

interface ParsedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export const MONEY_SCALE = 4;
export const MONEY_PRECISION = 19;
export const QUANTITY_SCALE = 6;
export const QUANTITY_PRECISION = 19;
export const PERCENTAGE_SCALE = 4;
export const PERCENTAGE_PRECISION = 7;

const MAX_INPUT_LENGTH = 128;
const MAX_SCALE = 36;

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function normalize(value: ParsedDecimal): ParsedDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function fieldName(format: DecimalFormat): string {
  return format.field ?? "amount";
}

function decimalText(input: DecimalInput, field: string): string {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`${field} must be a finite decimal`);
    if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
      throw new Error(`${field} must be a safe integer or decimal string`);
    }
    return String(input);
  }

  if (typeof input === "string" || typeof input === "bigint") return String(input).trim();
  if (input === null || typeof input !== "object") throw new Error(`${field} must be a decimal`);
  return input.toString().trim();
}

function parse(input: DecimalInput, format: DecimalFormat): ParsedDecimal {
  const field = fieldName(format);
  const text = decimalText(input, field);
  if (text.length === 0 || text.length > MAX_INPUT_LENGTH) {
    throw new Error(`${field} must be a decimal`);
  }

  const match = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new Error(`${field} must be a decimal`);

  const [, sign, whole, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) throw new Error(`${field} has an invalid exponent`);

  let scale = fraction.length - exponent;
  if (Math.abs(scale) > MAX_SCALE) {
    throw new Error(`${field} supports at most ${MAX_SCALE} decimal places`);
  }

  let coefficient = BigInt(`${sign === "-" ? "-" : ""}${whole}${fraction}`);
  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }
  return normalize({ coefficient, scale });
}

function validateFormat(format: DecimalFormat): void {
  if (!Number.isSafeInteger(format.scale) || format.scale < 0 || format.scale > MAX_SCALE) {
    throw new Error("decimal scale must be a whole number between 0 and 36");
  }
  if (
    format.precision !== undefined &&
    (!Number.isSafeInteger(format.precision) || format.precision < format.scale || format.precision < 1)
  ) {
    throw new Error("decimal precision must be a whole number at least as large as scale");
  }
}

function fixed(value: ParsedDecimal, format: DecimalFormat): CanonicalDecimal {
  const field = fieldName(format);
  if (value.coefficient < 0n) throw new Error(`${field} must be zero or greater`);
  if (value.scale > format.scale) {
    throw new Error(`${field} supports at most ${format.scale} decimal places`);
  }

  const coefficient = value.coefficient * powerOfTen(format.scale - value.scale);
  const digits = coefficient.toString().padStart(format.scale + 1, "0");
  const whole = format.scale === 0 ? digits : digits.slice(0, -format.scale);
  const fraction = format.scale === 0 ? "" : digits.slice(-format.scale);
  const integerDigits = whole === "0" ? 0 : whole.replace(/^0+(?=\d)/, "").length;
  if (format.precision !== undefined && integerDigits + format.scale > format.precision) {
    throw new Error(`${field} exceeds DECIMAL(${format.precision},${format.scale}) precision`);
  }
  return format.scale === 0 ? whole : `${whole}.${fraction}`;
}

/** Validates a nonnegative Decimal and returns a fixed, JSON-safe decimal string. */
export function canonicalDecimal(input: DecimalInput, format: DecimalFormat): CanonicalDecimal {
  validateFormat(format);
  return fixed(parse(input, format), format);
}

export function canonicalMoney(input: DecimalInput, field = "amount"): CanonicalDecimal {
  return canonicalDecimal(input, { scale: MONEY_SCALE, precision: MONEY_PRECISION, field });
}

export function canonicalQuantity(input: DecimalInput, field = "quantity"): CanonicalDecimal {
  return canonicalDecimal(input, { scale: QUANTITY_SCALE, precision: QUANTITY_PRECISION, field });
}

export function canonicalPercentage(input: DecimalInput, field = "percentage"): CanonicalDecimal {
  const format = {
    scale: PERCENTAGE_SCALE,
    precision: PERCENTAGE_PRECISION,
    field,
  } as const;
  const canonical = canonicalDecimal(input, format);
  if (compareDecimal(canonical, "100", format) > 0) {
    throw new Error(`${field} must not exceed 100`);
  }
  return canonical;
}

/**
 * Selects the new Decimal column before its legacy float. An invalid Decimal
 * never falls back: doing so would hide a partial or corrupt dual-write.
 */
export function decimalOrLegacy(
  input: DecimalOrLegacyInput,
  format: DecimalFormat
): CanonicalDecimal {
  if (input.decimal !== null && input.decimal !== undefined) {
    return canonicalDecimal(input.decimal, format);
  }
  if (input.legacy !== null && input.legacy !== undefined) {
    return canonicalDecimal(input.legacy, format);
  }
  throw new Error(`${fieldName(format)} is required`);
}

/**
 * Produces a temporary Float-compatible value only when converting it back at
 * the same fixed scale is lossless. This protects dual-writes from silently
 * persisting a different value in the legacy column.
 */
export function legacyNumber(input: DecimalInput, format: DecimalFormat): number {
  const canonical = canonicalDecimal(input, format);
  const legacy = Number(canonical);
  if (!Number.isFinite(legacy) || canonicalDecimal(legacy, format) !== canonical) {
    throw new Error(`${fieldName(format)} cannot be represented safely as a legacy number`);
  }
  return legacy;
}

function fixedCoefficient(input: DecimalInput, format: DecimalFormat): bigint {
  const canonical = canonicalDecimal(input, format);
  return BigInt(canonical.replace(".", ""));
}

/** Adds two values at one explicit scale without JavaScript floating-point arithmetic. */
export function addDecimal(
  left: DecimalInput,
  right: DecimalInput,
  format: DecimalFormat
): CanonicalDecimal {
  validateFormat(format);
  const coefficient = fixedCoefficient(left, format) + fixedCoefficient(right, format);
  return fixed({ coefficient, scale: format.scale }, format);
}

/** Compares two values at one explicit scale without JavaScript floating-point arithmetic. */
export function compareDecimal(left: DecimalInput, right: DecimalInput, format: DecimalFormat): number {
  validateFormat(format);
  const leftCoefficient = fixedCoefficient(left, format);
  const rightCoefficient = fixedCoefficient(right, format);
  return leftCoefficient === rightCoefficient ? 0 : leftCoefficient < rightCoefficient ? -1 : 1;
}
