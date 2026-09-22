import { z } from "zod";

/** A nonnegative JSON decimal without a sign, exponent, or ambiguous leading zero. */
export const DecimalStringSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
export type DecimalString = z.infer<typeof DecimalStringSchema>;

function fixedDecimalString(precision: number, scale: number) {
  const integerDigits = precision - scale;
  return z
    .string()
    .regex(new RegExp(`^(?:0|[1-9]\\d{0,${integerDigits - 1}})\\.\\d{${scale}}$`));
}

function boundedDecimalInputString(precision: number, scale: number) {
  const integerDigits = precision - scale;
  return z
    .string()
    .regex(
      new RegExp(
        `^(?:0|[1-9]\\d{0,${integerDigits - 1}})(?:\\.\\d{1,${scale}})?$`
      )
    );
}

/** Canonical DECIMAL(19,4) monetary JSON value. */
export const MoneyStringSchema = fixedDecimalString(19, 4);
export type MoneyString = z.infer<typeof MoneyStringSchema>;

/** Exact, nonnegative DECIMAL(19,4) input without required trailing zeroes. */
export const MoneyInputStringSchema = boundedDecimalInputString(19, 4);
export type MoneyInputString = z.infer<typeof MoneyInputStringSchema>;

/** Canonical DECIMAL(19,6) quantity JSON value. */
export const QuantityStringSchema = fixedDecimalString(19, 6);
export type QuantityString = z.infer<typeof QuantityStringSchema>;

/** Exact, nonnegative DECIMAL(19,6) input without required trailing zeroes. */
export const QuantityInputStringSchema = boundedDecimalInputString(19, 6);
export type QuantityInputString = z.infer<typeof QuantityInputStringSchema>;

/** Canonical DECIMAL(7,4) percentage JSON value from 0 through 100 inclusive. */
export const PercentageStringSchema = fixedDecimalString(7, 4).refine(
  (value) => BigInt(value.replace(".", "")) <= 1_000_000n,
  "percentage must not exceed 100.0000"
);
export type PercentageString = z.infer<typeof PercentageStringSchema>;

/** Exact percentage input without required trailing zeroes. */
export const PercentageInputStringSchema = boundedDecimalInputString(7, 4).refine(
  (value) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(4, "0")}`) <= 1_000_000n;
  },
  "percentage must not exceed 100"
);
export type PercentageInputString = z.infer<typeof PercentageInputStringSchema>;
