import { z } from "zod";
import {
  MoneyInputStringSchema,
  PercentageInputStringSchema,
  QuantityInputStringSchema,
} from "./decimal.js";

export const TransmissionMethodSchema = z.enum(["EMAIL", "PORTAL", "API"]);

const EmptyObjectSchema = z.strictObject({});
const NoBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const ValidationIssueSchema = z.strictObject({
  code: z.string(),
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationErrorResponseSchema = z.strictObject({
  error: z.literal("Request validation failed"),
  code: z.literal("VALIDATION_ERROR"),
  issues: z.array(ValidationIssueSchema),
});
export type ValidationErrorResponse = z.infer<typeof ValidationErrorResponseSchema>;

export const IdentifierSchema = z
  .string()
  .min(1, "Must not be empty")
  .max(200)
  .refine((value) => value.trim().length > 0, "Must not be blank");

export const IsoDateInputSchema = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
]);

function isPositiveDecimal(value: string): boolean {
  return /[1-9]/.test(value);
}

function decimalCoefficient(value: string, scale: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
}

function lessThanOrEqual(
  left: string | number,
  right: string | number,
  scale: number
): boolean {
  return typeof left === "string" && typeof right === "string"
    ? decimalCoefficient(left, scale) <= decimalCoefficient(right, scale)
    : Number(left) <= Number(right);
}

export const NonNegativeMoneyInputSchema = z.union([
  z.number().finite().nonnegative(),
  MoneyInputStringSchema,
]);
export const PositiveMoneyInputSchema = z.union([
  z.number().finite().positive(),
  MoneyInputStringSchema.refine(isPositiveDecimal, "Must be greater than zero"),
]);
export const PositiveQuantityInputSchema = z.union([
  z.number().finite().positive(),
  QuantityInputStringSchema.refine(isPositiveDecimal, "Must be greater than zero"),
]);
export const PercentageInputSchema = z.union([
  z.number().finite().min(0).max(100),
  PercentageInputStringSchema,
]);

const EmptyParamsSchema = EmptyObjectSchema;
const EmptyQuerySchema = EmptyObjectSchema;
const IdParamsSchema = z.strictObject({ id: IdentifierSchema });

function requestSchema<
  Params extends z.ZodType,
  Query extends z.ZodType,
  Body extends z.ZodType,
>(params: Params, query: Query, body: Body) {
  return z.strictObject({ params, query, body });
}

const EmptyRequestSchema = requestSchema(
  EmptyParamsSchema,
  EmptyQuerySchema,
  NoBodySchema
);

const CustomerFilterQuerySchema = z.strictObject({
  customerId: IdentifierSchema.optional(),
});

const ReportPeriodQuerySchema = z
  .strictObject({
    from: IsoDateInputSchema.optional(),
    to: IsoDateInputSchema.optional(),
  })
  .refine(
    ({ from, to }) => from === undefined || to === undefined || Date.parse(from) <= Date.parse(to),
    { path: ["to"], message: "Must be on or after from" }
  );

const RateTierInputSchema = z
  .strictObject({
    upTo: PositiveQuantityInputSchema.nullable(),
    unitPrice: NonNegativeMoneyInputSchema,
    floor: NonNegativeMoneyInputSchema.nullish(),
    ceiling: NonNegativeMoneyInputSchema.nullish(),
  })
  .refine(
    ({ floor, ceiling }) =>
      floor == null || ceiling == null || lessThanOrEqual(floor, ceiling, 4),
    { path: ["ceiling"], message: "Must be greater than or equal to floor" }
  );

const RateTiersInputSchema = z
  .array(RateTierInputSchema)
  .max(100)
  .superRefine((tiers, context) => {
    let previousLimit: string | number = 0;
    for (const [index, tier] of tiers.entries()) {
      if (tier.upTo === null) {
        if (index !== tiers.length - 1) {
          context.addIssue({
            code: "custom",
            path: [index, "upTo"],
            message: "An unbounded tier must be last",
          });
        }
        continue;
      }
      const currentLimit = tier.upTo;
      if (lessThanOrEqual(currentLimit, previousLimit, 6)) {
        context.addIssue({
          code: "custom",
          path: [index, "upTo"],
          message: "Tier limits must be strictly increasing",
        });
      }
      previousLimit = currentLimit;
    }
  });

const OrderItemInputSchema = z.strictObject({
  productId: IdentifierSchema,
  quantity: PositiveQuantityInputSchema,
});

const OrderItemUpdateInputSchema = z.strictObject({
  id: IdentifierSchema,
  quantity: PositiveQuantityInputSchema,
});

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string
): boolean {
  return new Set(values.map(key)).size === values.length;
}

export const ListCustomersRequestSchema = EmptyRequestSchema;
export type ListCustomersRequest = z.infer<typeof ListCustomersRequestSchema>;

export const ListProductsRequestSchema = EmptyRequestSchema;
export type ListProductsRequest = z.infer<typeof ListProductsRequestSchema>;

export const ListRatesRequestSchema = requestSchema(
  EmptyParamsSchema,
  CustomerFilterQuerySchema,
  NoBodySchema
);
export type ListRatesRequest = z.infer<typeof ListRatesRequestSchema>;

export const ListComboDiscountsRequestSchema = ListRatesRequestSchema;
export type ListComboDiscountsRequest = z.infer<typeof ListComboDiscountsRequestSchema>;

export const CreateComboDiscountRequestSchema = requestSchema(
  EmptyParamsSchema,
  EmptyQuerySchema,
  z.strictObject({
    name: z.string().trim().min(1).max(200),
    productIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Product IDs must be unique"),
    percentOff: PercentageInputSchema,
    customerId: IdentifierSchema.nullable().optional(),
  })
);
export type CreateComboDiscountRequest = z.infer<
  typeof CreateComboDiscountRequestSchema
>;

export const UpdateRateRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  z.strictObject({
    unitPrice: NonNegativeMoneyInputSchema,
    tiers: RateTiersInputSchema.optional(),
  })
);
export type UpdateRateRequest = z.infer<typeof UpdateRateRequestSchema>;

export const ListOrdersRequestSchema = EmptyRequestSchema;
export type ListOrdersRequest = z.infer<typeof ListOrdersRequestSchema>;

export const GetOrderRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  NoBodySchema
);
export type GetOrderRequest = z.infer<typeof GetOrderRequestSchema>;

export const CreateOrderRequestSchema = requestSchema(
  EmptyParamsSchema,
  EmptyQuerySchema,
  z.strictObject({
    customerId: IdentifierSchema,
    items: z
      .array(OrderItemInputSchema)
      .min(1)
      .max(1_000)
      .refine(
        (items) => uniqueBy(items, (item) => item.productId),
        "Product IDs must be unique"
      ),
    notes: z.string().max(10_000).optional(),
  })
);
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

const UpdateOrderBodySchema = z
  .strictObject({
    customerId: IdentifierSchema.optional(),
    orderDate: IsoDateInputSchema.optional(),
    notes: z.string().max(10_000).optional(),
    items: z
      .array(OrderItemUpdateInputSchema)
      .max(1_000)
      .refine(
        (items) => uniqueBy(items, (item) => item.id),
        "Order item IDs must be unique"
      )
      .optional(),
    comment: z
      .strictObject({
        author: z.string().trim().min(1).max(200).optional(),
        body: z.string().trim().min(1).max(5_000),
      })
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "At least one update field is required",
  });

export const UpdateOrderRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  UpdateOrderBodySchema
);
export type UpdateOrderRequest = z.infer<typeof UpdateOrderRequestSchema>;

export const CreateInvoiceForOrderRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  NoBodySchema
);
export type CreateInvoiceForOrderRequest = z.infer<
  typeof CreateInvoiceForOrderRequestSchema
>;

export const ListInvoicesRequestSchema = EmptyRequestSchema;
export type ListInvoicesRequest = z.infer<typeof ListInvoicesRequestSchema>;

export const GetInvoiceRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  NoBodySchema
);
export type GetInvoiceRequest = z.infer<typeof GetInvoiceRequestSchema>;

const UpdateInvoiceBodySchema = z
  .strictObject({
    issueDate: IsoDateInputSchema.optional(),
    dueDate: IsoDateInputSchema.optional(),
  })
  .refine((body) => body.issueDate !== undefined || body.dueDate !== undefined, {
    message: "At least one date is required",
  })
  .refine(
    ({ issueDate, dueDate }) =>
      issueDate === undefined ||
      dueDate === undefined ||
      Date.parse(issueDate) <= Date.parse(dueDate),
    { path: ["dueDate"], message: "Must be on or after issueDate" }
  );

export const UpdateInvoiceRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  UpdateInvoiceBodySchema
);
export type UpdateInvoiceRequest = z.infer<typeof UpdateInvoiceRequestSchema>;

export const PostInvoiceRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  NoBodySchema
);
export type PostInvoiceRequest = z.infer<typeof PostInvoiceRequestSchema>;

export const SendInvoiceRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  z.strictObject({ method: TransmissionMethodSchema })
);
export type SendInvoiceRequest = z.infer<typeof SendInvoiceRequestSchema>;

export const RefreshTransmissionRequestSchema = requestSchema(
  z.strictObject({ transmissionId: IdentifierSchema }),
  EmptyQuerySchema,
  NoBodySchema
);
export type RefreshTransmissionRequest = z.infer<
  typeof RefreshTransmissionRequestSchema
>;

export const ListPaymentsRequestSchema = EmptyRequestSchema;
export type ListPaymentsRequest = z.infer<typeof ListPaymentsRequestSchema>;

export const GetPaymentRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  NoBodySchema
);
export type GetPaymentRequest = z.infer<typeof GetPaymentRequestSchema>;

export const RecordPaymentRequestSchema = requestSchema(
  EmptyParamsSchema,
  EmptyQuerySchema,
  z.strictObject({
    customerId: IdentifierSchema,
    amount: PositiveMoneyInputSchema,
    reference: z.string().max(500).optional(),
  })
);
export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequestSchema>;

const PaymentApplicationInputSchema = z.strictObject({
  invoiceId: IdentifierSchema,
  amount: PositiveMoneyInputSchema,
});

export const ApplyPaymentRequestSchema = requestSchema(
  IdParamsSchema,
  EmptyQuerySchema,
  z.strictObject({
    applications: z
      .array(PaymentApplicationInputSchema)
      .min(1)
      .max(1_000)
      .refine(
        (applications) => uniqueBy(applications, (application) => application.invoiceId),
        "Invoice IDs must be unique"
      ),
  })
);
export type ApplyPaymentRequest = z.infer<typeof ApplyPaymentRequestSchema>;

export const RevenueReportRequestSchema = requestSchema(
  EmptyParamsSchema,
  ReportPeriodQuerySchema,
  NoBodySchema
);
export type RevenueReportRequest = z.infer<typeof RevenueReportRequestSchema>;
