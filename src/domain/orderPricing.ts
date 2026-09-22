import {
  CurrencyCodeSchema,
  ExactRateTierSchema,
  MoneyStringSchema,
  PercentageStringSchema,
  QuantityStringSchema,
  type MoneyString,
} from "@meridian/contracts";
import { z } from "zod";
import { canonicalMoney, canonicalQuantity, canonicalPercentage } from "./money";
import { calculateLinePricing, tieredSubtotal } from "./pricing";

export const ORDER_PRICING_SNAPSHOT_VERSION = 1 as const;
export const ORDER_PRICING_ROUNDING_POLICY = "LINE_HALF_AWAY_FROM_ZERO_2DP" as const;

const NonEmptyStringSchema = z.string().trim().min(1);

export const OrderPricingProductSchema = z
  .object({
    id: NonEmptyStringSchema,
    sku: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    unit: NonEmptyStringSchema,
    currencyCode: CurrencyCodeSchema,
  })
  .strict();

export const OrderPricingRateSchema = z
  .object({
    id: NonEmptyStringSchema,
    currencyCode: CurrencyCodeSchema,
    baseUnitPrice: MoneyStringSchema,
    tiers: z.array(ExactRateTierSchema),
  })
  .strict();

export const OrderPricingDiscountInputSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    percentOff: PercentageStringSchema,
  })
  .strict();

export const OrderPricingInputSchema = z
  .object({
    product: OrderPricingProductSchema,
    rate: OrderPricingRateSchema,
    quantity: QuantityStringSchema.refine((value) => BigInt(value.replace(".", "")) > 0n, {
      message: "quantity must be greater than zero",
    }),
    discounts: z.array(OrderPricingDiscountInputSchema),
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.product.currencyCode !== input.rate.currencyCode) {
      context.addIssue({
        code: "custom",
        path: ["rate", "currencyCode"],
        message: "product and rate currencies must match",
      });
    }
    const discountIds = new Set<string>();
    input.discounts.forEach((discount, index) => {
      if (discountIds.has(discount.id)) {
        context.addIssue({
          code: "custom",
          path: ["discounts", index, "id"],
          message: "discount ids must be unique",
        });
      }
      discountIds.add(discount.id);
    });
  });

const AppliedDiscountSchema = OrderPricingDiscountInputSchema.extend({
  amountBefore: MoneyStringSchema,
  discountAmount: MoneyStringSchema,
  amountAfter: MoneyStringSchema,
});

export const OrderPricingSnapshotSchema = z
  .object({
    version: z.literal(ORDER_PRICING_SNAPSHOT_VERSION),
    capturedAt: z.iso.datetime({ offset: true }),
    roundingPolicy: z.literal(ORDER_PRICING_ROUNDING_POLICY),
    currencyCode: CurrencyCodeSchema,
    product: OrderPricingProductSchema.omit({ currencyCode: true }),
    rate: OrderPricingRateSchema.omit({ currencyCode: true }),
    quantity: QuantityStringSchema,
    subtotal: MoneyStringSchema,
    discounts: z.array(AppliedDiscountSchema),
    total: MoneyStringSchema,
  })
  .strict();

export const CapturedOrderPricingSchema = z
  .object({
    productId: NonEmptyStringSchema,
    rateId: NonEmptyStringSchema,
    productSkuSnapshot: NonEmptyStringSchema,
    productNameSnapshot: NonEmptyStringSchema,
    productUnitSnapshot: NonEmptyStringSchema,
    currencyCode: CurrencyCodeSchema,
    quantityDecimal: QuantityStringSchema,
    baseUnitPriceDecimal: MoneyStringSchema,
    effectiveUnitPriceDecimal: MoneyStringSchema,
    amountDecimal: MoneyStringSchema,
    pricingCapturedAt: z.iso.datetime({ offset: true }),
    snapshotVersion: z.literal(ORDER_PRICING_SNAPSHOT_VERSION),
    pricingSnapshot: OrderPricingSnapshotSchema,
  })
  .strict();

export type OrderPricingInput = z.infer<typeof OrderPricingInputSchema>;
export type OrderPricingSnapshot = z.infer<typeof OrderPricingSnapshotSchema>;
export type CapturedOrderPricing = z.infer<typeof CapturedOrderPricingSchema>;

function coefficient(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

/** Divide a fixed-scale line amount by a positive quantity and round half up to DECIMAL(19,4). */
function blendedUnitPrice(amount: MoneyString, quantity: string): MoneyString {
  const numerator = coefficient(amount) * 1_000_000n;
  const denominator = coefficient(quantity);
  let rounded = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) rounded += 1n;
  const digits = rounded.toString().padStart(5, "0");
  return MoneyStringSchema.parse(`${digits.slice(0, -4)}.${digits.slice(-4)}`);
}

/**
 * Captures every commercial input needed to explain an order line. Tier and
 * discount calculations use bigint-backed pricing; JavaScript numbers never
 * participate in persisted money arithmetic.
 */
export function captureOrderPricing(rawInput: OrderPricingInput): CapturedOrderPricing {
  const input = OrderPricingInputSchema.parse(rawInput);
  const tiers = input.rate.tiers.map((tier) => ({ ...tier }));
  const subtotal = MoneyStringSchema.parse(
    canonicalMoney(
      tieredSubtotal(input.rate.baseUnitPrice, input.quantity, tiers),
      "order line subtotal"
    )
  );

  let amount = subtotal;
  const discounts = input.discounts
    .map((discount) => ({ ...discount }))
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((discount) => {
      const result = calculateLinePricing({
        quantity: "1",
        unitPrice: amount,
        discountPercent: discount.percentOff,
      });
      const amountBefore = amount;
      const discountAmount = MoneyStringSchema.parse(
        canonicalMoney(result.discount, `discount ${discount.id} amount`)
      );
      amount = MoneyStringSchema.parse(
        canonicalMoney(result.total, `discount ${discount.id} result`)
      );
      return AppliedDiscountSchema.parse({
        ...discount,
        amountBefore,
        discountAmount,
        amountAfter: amount,
      });
    });

  const effectiveUnitPriceDecimal = blendedUnitPrice(amount, input.quantity);
  const pricingSnapshot = OrderPricingSnapshotSchema.parse({
    version: ORDER_PRICING_SNAPSHOT_VERSION,
    capturedAt: input.capturedAt,
    roundingPolicy: ORDER_PRICING_ROUNDING_POLICY,
    currencyCode: input.rate.currencyCode,
    product: {
      id: input.product.id,
      sku: input.product.sku,
      name: input.product.name,
      unit: input.product.unit,
    },
    rate: {
      id: input.rate.id,
      baseUnitPrice: input.rate.baseUnitPrice,
      tiers,
    },
    quantity: input.quantity,
    subtotal,
    discounts,
    total: amount,
  });

  return CapturedOrderPricingSchema.parse({
    productId: input.product.id,
    rateId: input.rate.id,
    productSkuSnapshot: input.product.sku,
    productNameSnapshot: input.product.name,
    productUnitSnapshot: input.product.unit,
    currencyCode: input.rate.currencyCode,
    quantityDecimal: canonicalQuantity(input.quantity, "order line quantity"),
    baseUnitPriceDecimal: canonicalMoney(input.rate.baseUnitPrice, "order line base unit price"),
    effectiveUnitPriceDecimal,
    amountDecimal: amount,
    pricingCapturedAt: input.capturedAt,
    snapshotVersion: ORDER_PRICING_SNAPSHOT_VERSION,
    pricingSnapshot,
  });
}

export function exactPricingInput(input: {
  product: Omit<z.input<typeof OrderPricingProductSchema>, "currencyCode"> & {
    currencyCode: string;
  };
  rate: Omit<z.input<typeof OrderPricingRateSchema>, "baseUnitPrice" | "tiers"> & {
    baseUnitPrice: string | number;
    tiers: readonly {
      upTo: string | number | null;
      unitPrice: string | number;
      floor?: string | number | null;
      ceiling?: string | number | null;
    }[];
  };
  quantity: string | number;
  discounts: readonly { id: string; name: string; percentOff: string | number }[];
  capturedAt: string;
}): OrderPricingInput {
  return OrderPricingInputSchema.parse({
    product: input.product,
    rate: {
      ...input.rate,
      baseUnitPrice: canonicalMoney(input.rate.baseUnitPrice, "order line base unit price"),
      tiers: input.rate.tiers.map((tier) => ({
        upTo: tier.upTo === null ? null : canonicalQuantity(tier.upTo, "tier upper bound"),
        unitPrice: canonicalMoney(tier.unitPrice, "tier unit price"),
        ...(tier.floor === undefined
          ? {}
          : { floor: tier.floor === null ? null : canonicalMoney(tier.floor, "tier floor") }),
        ...(tier.ceiling === undefined
          ? {}
          : {
              ceiling:
                tier.ceiling === null ? null : canonicalMoney(tier.ceiling, "tier ceiling"),
            }),
      })),
    },
    quantity: canonicalQuantity(input.quantity, "order line quantity"),
    discounts: input.discounts.map((discount) => ({
      ...discount,
      percentOff: canonicalPercentage(discount.percentOff, `discount ${discount.id} percentage`),
    })),
    capturedAt: input.capturedAt,
  });
}
