import type { RateTier } from "./rateTier";

/**
 * Decimal values enter pricing as strings (preferred), bigints, or legacy
 * numbers. All arithmetic below is performed with bigint coefficients so no
 * monetary calculation uses JavaScript binary floating point.
 */
export type DecimalInput = string | number | bigint;
export type Money = string;

export type RateTierInput = Omit<RateTier, "upTo" | "unitPrice" | "floor" | "ceiling"> & {
  readonly upTo: DecimalInput | null;
  readonly unitPrice: DecimalInput;
  readonly floor?: DecimalInput | null;
  readonly ceiling?: DecimalInput | null;
};

export interface LinePricingInput {
  readonly quantity: DecimalInput;
  readonly unitPrice: DecimalInput;
  readonly tiers?: readonly RateTierInput[];
  readonly discountPercent?: DecimalInput;
  readonly taxPercent?: DecimalInput;
}

export interface LinePricing {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly taxableAmount: Money;
  readonly tax: Money;
  readonly total: Money;
}

export interface PricingTotals extends LinePricing {}

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const MONEY_SCALE = 2;
const MAX_INPUT_LENGTH = 128;
const MAX_SCALE = 36;
const ZERO: Decimal = { coefficient: 0n, scale: 0 };
const HUNDRED = parseDecimal("100", "percentage divisor");

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function normalize(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function parseDecimal(input: DecimalInput, field: string): Decimal {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`${field} must be a finite decimal`);
    if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
      throw new Error(`${field} must be a safe integer or a decimal string`);
    }
  }

  const text = String(input).trim();
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

function align(left: Decimal, right: Decimal): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

function add(left: Decimal, right: Decimal): Decimal {
  const [leftCoefficient, rightCoefficient, scale] = align(left, right);
  return normalize({ coefficient: leftCoefficient + rightCoefficient, scale });
}

function subtract(left: Decimal, right: Decimal): Decimal {
  const [leftCoefficient, rightCoefficient, scale] = align(left, right);
  return normalize({ coefficient: leftCoefficient - rightCoefficient, scale });
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return normalize({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

function compare(left: Decimal, right: Decimal): number {
  const [leftCoefficient, rightCoefficient] = align(left, right);
  if (leftCoefficient < rightCoefficient) return -1;
  if (leftCoefficient > rightCoefficient) return 1;
  return 0;
}

function divideByHundred(value: Decimal): Decimal {
  return normalize({ coefficient: value.coefficient, scale: value.scale + HUNDRED.scale + 2 });
}

function round(value: Decimal, scale: number): Decimal {
  if (value.scale <= scale) {
    return {
      coefficient: value.coefficient * powerOfTen(scale - value.scale),
      scale,
    };
  }

  const divisor = powerOfTen(value.scale - scale);
  let coefficient = value.coefficient / divisor;
  const remainder = value.coefficient % divisor;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  if (absoluteRemainder * 2n >= divisor) coefficient += value.coefficient < 0n ? -1n : 1n;
  return { coefficient, scale };
}

function format(value: Decimal): string {
  const rounded = round(value, MONEY_SCALE);
  const negative = rounded.coefficient < 0n;
  const digits = (negative ? -rounded.coefficient : rounded.coefficient)
    .toString()
    .padStart(MONEY_SCALE + 1, "0");
  const whole = digits.slice(0, -MONEY_SCALE);
  const fraction = digits.slice(-MONEY_SCALE);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function requireNonNegative(value: Decimal, field: string): void {
  if (compare(value, ZERO) < 0) throw new Error(`${field} must be zero or greater`);
}

function moneyDecimal(input: DecimalInput, field: string): Decimal {
  return parseDecimal(format(parseDecimal(input, field)), field);
}

function percentage(input: DecimalInput | undefined, field: string, maximum?: Decimal): Decimal {
  const value = parseDecimal(input ?? 0, field);
  requireNonNegative(value, field);
  if (maximum && compare(value, maximum) > 0) {
    throw new Error(`${field} must not exceed 100`);
  }
  return value;
}

function percentageOf(amount: Decimal, percent: Decimal): Decimal {
  return divideByHundred(multiply(amount, percent));
}

function rawSubtotal(
  unitPriceInput: DecimalInput,
  quantityInput: DecimalInput,
  unitPriceField: string,
  quantityField: string
): Decimal {
  const unitPrice = parseDecimal(unitPriceInput, unitPriceField);
  const quantity = parseDecimal(quantityInput, quantityField);
  requireNonNegative(unitPrice, unitPriceField);
  requireNonNegative(quantity, quantityField);
  return multiply(unitPrice, quantity);
}

function rawTieredSubtotal(
  quantityInput: DecimalInput,
  unitPriceInput: DecimalInput,
  tiers: readonly RateTierInput[]
): Decimal {
  const quantity = parseDecimal(quantityInput, "quantity");
  const unitPrice = parseDecimal(unitPriceInput, "unit price");
  requireNonNegative(quantity, "quantity");
  requireNonNegative(unitPrice, "unit price");
  if (compare(quantity, ZERO) === 0) return ZERO;
  if (tiers.length === 0) return multiply(quantity, unitPrice);

  const normalizedTiers = tiers.map((tier, index) => {
    const upTo = tier.upTo === null ? null : parseDecimal(tier.upTo, `tier ${index} upper bound`);
    const tierUnitPrice = parseDecimal(tier.unitPrice, `tier ${index} unit price`);
    const floor =
      tier.floor === null || tier.floor === undefined
        ? null
        : parseDecimal(tier.floor, `tier ${index} floor`);
    const ceiling =
      tier.ceiling === null || tier.ceiling === undefined
        ? null
        : parseDecimal(tier.ceiling, `tier ${index} ceiling`);

    if (upTo) requireNonNegative(upTo, `tier ${index} upper bound`);
    requireNonNegative(tierUnitPrice, `tier ${index} unit price`);
    if (floor) requireNonNegative(floor, `tier ${index} floor`);
    if (ceiling) requireNonNegative(ceiling, `tier ${index} ceiling`);
    if (floor && ceiling && compare(floor, ceiling) > 0) {
      throw new Error(`tier ${index} floor must not exceed its ceiling`);
    }
    return { upTo, unitPrice: tierUnitPrice, floor, ceiling };
  });

  let previousBound = ZERO;
  for (const [index, tier] of normalizedTiers.entries()) {
    if (tier.upTo && compare(tier.upTo, previousBound) <= 0) {
      throw new Error(`tier ${index} upper bound must be greater than the previous bound`);
    }
    if (index < normalizedTiers.length - 1 && tier.upTo === null) {
      throw new Error(`only the final tier may have an open upper bound`);
    }
    if (tier.upTo) previousBound = tier.upTo;
  }

  let covered = ZERO;
  let subtotal = ZERO;
  for (const tier of normalizedTiers) {
    if (compare(covered, quantity) >= 0) break;

    const upper = tier.upTo && compare(tier.upTo, quantity) < 0 ? tier.upTo : quantity;
    const units = subtract(upper, covered);
    let tierCharge = multiply(units, tier.unitPrice);
    if (tier.floor && compare(tierCharge, tier.floor) < 0) tierCharge = tier.floor;
    if (tier.ceiling && compare(tierCharge, tier.ceiling) > 0) tierCharge = tier.ceiling;
    subtotal = add(subtotal, tierCharge);
    covered = upper;
  }

  if (compare(covered, quantity) < 0) {
    throw new Error("rate tiers do not cover the full quantity");
  }
  return subtotal;
}

export function productSubtotal(unitPrice: DecimalInput, quantity: DecimalInput): Money {
  return format(rawSubtotal(unitPrice, quantity, "unit price", "quantity"));
}

export function hourlySubtotal(hourlyRate: DecimalInput, hours: DecimalInput): Money {
  return format(rawSubtotal(hourlyRate, hours, "hourly rate", "hours"));
}

export function subscriptionSubtotal(
  periodRate: DecimalInput,
  periods: DecimalInput = 1
): Money {
  return format(rawSubtotal(periodRate, periods, "period rate", "periods"));
}

export function tieredSubtotal(
  unitPrice: DecimalInput,
  quantity: DecimalInput,
  tiers: readonly RateTierInput[]
): Money {
  return format(rawTieredSubtotal(quantity, unitPrice, tiers));
}

export function calculateLinePricing(input: LinePricingInput): LinePricing {
  const subtotal = moneyDecimal(
    tieredSubtotal(input.unitPrice, input.quantity, input.tiers ?? []),
    "subtotal"
  );
  const discountPercent = percentage(input.discountPercent, "discount percent", HUNDRED);
  const taxPercent = percentage(input.taxPercent, "tax percent");
  const discount = moneyDecimal(format(percentageOf(subtotal, discountPercent)), "discount");
  const taxableAmount = subtract(subtotal, discount);
  const tax = moneyDecimal(format(percentageOf(taxableAmount, taxPercent)), "tax");
  const total = add(taxableAmount, tax);

  return {
    subtotal: format(subtotal),
    discount: format(discount),
    taxableAmount: format(taxableAmount),
    tax: format(tax),
    total: format(total),
  };
}

export function calculatePricingTotals(lines: readonly LinePricing[]): PricingTotals {
  const totals = lines.reduce(
    (sum, line) => ({
      subtotal: add(sum.subtotal, moneyDecimal(line.subtotal, "line subtotal")),
      discount: add(sum.discount, moneyDecimal(line.discount, "line discount")),
      taxableAmount: add(
        sum.taxableAmount,
        moneyDecimal(line.taxableAmount, "line taxable amount")
      ),
      tax: add(sum.tax, moneyDecimal(line.tax, "line tax")),
      total: add(sum.total, moneyDecimal(line.total, "line total")),
    }),
    { subtotal: ZERO, discount: ZERO, taxableAmount: ZERO, tax: ZERO, total: ZERO }
  );

  return {
    subtotal: format(totals.subtotal),
    discount: format(totals.discount),
    taxableAmount: format(totals.taxableAmount),
    tax: format(totals.tax),
    total: format(totals.total),
  };
}
