import {
  CurrencyCodeSchema,
  InvoiceStatusSchema,
  MoneyStringSchema,
} from "@meridian/contracts";
import { z } from "zod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  compareDecimal,
  subtractDecimal,
} from "./money";

const moneyFormat = {
  scale: MONEY_SCALE,
  precision: MONEY_PRECISION,
  field: "payment reversal amount",
} as const;
const id = z.string().min(1);

export const PaymentReversalPlanRequestSchema = z.strictObject({
  requestedPaymentId: id,
  amount: MoneyStringSchema,
  application: z.strictObject({
    id,
    paymentId: id,
    amount: MoneyStringSchema,
    reversedAmount: MoneyStringSchema,
    paymentCustomerId: id,
    paymentCurrencyCode: CurrencyCodeSchema,
    invoiceCustomerId: id,
    invoiceCurrencyCode: CurrencyCodeSchema,
  }),
  invoice: z.strictObject({
    status: InvoiceStatusSchema,
    total: MoneyStringSchema,
    grossAppliedAmount: MoneyStringSchema,
    reversedAmount: MoneyStringSchema,
    hasSuccessfulDelivery: z.boolean(),
  }),
});
export type PaymentReversalPlanRequest = z.infer<
  typeof PaymentReversalPlanRequestSchema
>;

export const PaymentReversalPlanSchema = z.strictObject({
  applicationRemainingBefore: MoneyStringSchema,
  applicationRemainingAfter: MoneyStringSchema,
  invoiceAmountPaidBefore: MoneyStringSchema,
  invoiceAmountPaidAfter: MoneyStringSchema,
  invoiceStatusAfter: z.enum(["POSTED", "SENT", "PAID"]),
});
export type PaymentReversalPlan = z.infer<typeof PaymentReversalPlanSchema>;

/** Pure exact-decimal planner; callers map its rule failures to public problems. */
export function planPaymentApplicationReversal(input: unknown): PaymentReversalPlan {
  const request = PaymentReversalPlanRequestSchema.parse(input);
  if (compareDecimal(request.amount, "0.0000", moneyFormat) <= 0) {
    throw new Error("reversal amount must be greater than zero");
  }
  if (request.requestedPaymentId !== request.application.paymentId) {
    throw new Error("payment application does not belong to the requested payment");
  }
  if (request.application.paymentCustomerId !== request.application.invoiceCustomerId) {
    throw new Error("payment and invoice customers do not match");
  }
  if (request.application.paymentCurrencyCode !== request.application.invoiceCurrencyCode) {
    throw new Error("payment and invoice currencies do not match");
  }
  if (!new Set(["POSTED", "SENT", "PAID"]).has(request.invoice.status)) {
    throw new Error("payment application invoice is not reversible");
  }

  if (
    compareDecimal(
      request.application.reversedAmount,
      request.application.amount,
      moneyFormat
    ) > 0
  ) {
    throw new Error("application is already over-reversed");
  }
  if (
    compareDecimal(
      request.invoice.reversedAmount,
      request.invoice.grossAppliedAmount,
      moneyFormat
    ) > 0
  ) {
    throw new Error("invoice is already over-reversed");
  }
  const applicationRemainingBefore = subtractDecimal(
    request.application.amount,
    request.application.reversedAmount,
    moneyFormat
  );
  if (compareDecimal(request.amount, applicationRemainingBefore, moneyFormat) > 0) {
    throw new Error("reversal exceeds the application remaining amount");
  }
  const invoiceAmountPaidBefore = subtractDecimal(
    request.invoice.grossAppliedAmount,
    request.invoice.reversedAmount,
    moneyFormat
  );
  const invoiceAmountPaidAfter = subtractDecimal(
    invoiceAmountPaidBefore,
    request.amount,
    moneyFormat
  );
  if (compareDecimal(invoiceAmountPaidBefore, request.invoice.total, moneyFormat) > 0) {
    throw new Error("invoice applications exceed the invoice total");
  }
  const applicationRemainingAfter = subtractDecimal(
    applicationRemainingBefore,
    request.amount,
    moneyFormat
  );
  const invoiceStatusAfter =
    compareDecimal(invoiceAmountPaidAfter, request.invoice.total, moneyFormat) === 0
      ? "PAID"
      : request.invoice.hasSuccessfulDelivery
        ? "SENT"
        : "POSTED";

  return PaymentReversalPlanSchema.parse({
    applicationRemainingBefore,
    applicationRemainingAfter,
    invoiceAmountPaidBefore,
    invoiceAmountPaidAfter,
    invoiceStatusAfter,
  });
}
