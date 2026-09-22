import {
  CurrencyCodeSchema,
  InvoiceStatusSchema,
  MoneyStringSchema,
  type MoneyString,
} from "@meridian/contracts";
import { z } from "zod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  addDecimal,
  canonicalMoney,
  compareDecimal,
  subtractDecimal,
} from "./money";

const moneyFormat = {
  scale: MONEY_SCALE,
  precision: MONEY_PRECISION,
  field: "amount",
} as const;
const zeroMoney = canonicalMoney("0");

const identifier = z.string().min(1);

const invoiceStatus = InvoiceStatusSchema.enum;

export const EligibleInvoiceStatusSchema = z.union([
  z.literal(invoiceStatus.POSTED),
  z.literal(invoiceStatus.SENT),
]);
export type EligibleInvoiceStatus = z.infer<typeof EligibleInvoiceStatusSchema>;

export const PaymentAllocationRequestSchema = z.strictObject({
  payment: z.strictObject({
    id: identifier,
    customerId: identifier,
    currencyCode: CurrencyCodeSchema,
    remainingAmount: MoneyStringSchema,
  }),
  invoices: z.array(
    z.strictObject({
      id: identifier,
      customerId: identifier,
      currencyCode: CurrencyCodeSchema,
      status: InvoiceStatusSchema,
      remainingAmount: MoneyStringSchema,
    })
  ),
  applications: z
    .array(
      z.strictObject({
        invoiceId: identifier,
        amount: MoneyStringSchema,
      })
    )
    .min(1),
});
export type PaymentAllocationRequest = z.infer<typeof PaymentAllocationRequestSchema>;

export const PlannedPaymentApplicationSchema = z.strictObject({
  invoiceId: identifier,
  amount: MoneyStringSchema,
  invoiceRemainingBefore: MoneyStringSchema,
  invoiceRemainingAfter: MoneyStringSchema,
});
export type PlannedPaymentApplication = z.infer<typeof PlannedPaymentApplicationSchema>;

export const PaymentAllocationPlanSchema = z.strictObject({
  paymentId: identifier,
  paymentRemainingBefore: MoneyStringSchema,
  appliedAmount: MoneyStringSchema,
  paymentRemainingAfter: MoneyStringSchema,
  /** Sorted by invoice ID so equivalent input produces the same plan. */
  applications: z.array(PlannedPaymentApplicationSchema),
});
export type PaymentAllocationPlan = z.infer<typeof PaymentAllocationPlanSchema>;

function requirePositive(amount: MoneyString, field: string): void {
  if (compareDecimal(amount, zeroMoney, moneyFormat) <= 0) {
    throw new Error(`${field} must be greater than zero`);
  }
}

/**
 * Creates an exact, deterministic allocation plan from a single state snapshot.
 * Persisting it still requires a serializable transaction or compare-and-set
 * update: a later writer can change balances after this pure plan is built.
 */
export function planPaymentAllocation(input: unknown): PaymentAllocationPlan {
  const request = PaymentAllocationRequestSchema.parse(input);
  const invoicesById = new Map(request.invoices.map((invoice) => [invoice.id, invoice]));
  if (invoicesById.size !== request.invoices.length) {
    throw new Error("invoice IDs must be unique");
  }

  const applicationsByInvoiceId = new Map<string, PaymentAllocationRequest["applications"][number]>();
  for (const application of request.applications) {
    if (applicationsByInvoiceId.has(application.invoiceId)) {
      throw new Error("application invoice IDs must be unique");
    }
    applicationsByInvoiceId.set(application.invoiceId, application);
  }

  let appliedAmount = zeroMoney;
  const plannedApplications: PlannedPaymentApplication[] = [];
  for (const [invoiceId, application] of applicationsByInvoiceId) {
    const invoice = invoicesById.get(invoiceId);
    if (!invoice) throw new Error(`invoice ${invoiceId} is not available for this payment`);
    if (invoice.customerId !== request.payment.customerId) {
      throw new Error(`invoice ${invoiceId} belongs to a different customer`);
    }
    if (invoice.currencyCode !== request.payment.currencyCode) {
      throw new Error(`invoice ${invoiceId} has a different currency`);
    }
    if (!EligibleInvoiceStatusSchema.safeParse(invoice.status).success) {
      throw new Error(`invoice ${invoiceId} must be POSTED or SENT before payment application`);
    }

    requirePositive(application.amount, `application for invoice ${invoiceId}`);
    if (compareDecimal(application.amount, invoice.remainingAmount, moneyFormat) > 0) {
      throw new Error(`application for invoice ${invoiceId} exceeds its remaining balance`);
    }
    appliedAmount = addDecimal(appliedAmount, application.amount, moneyFormat);
    plannedApplications.push({
      invoiceId,
      amount: application.amount,
      invoiceRemainingBefore: invoice.remainingAmount,
      invoiceRemainingAfter: subtractDecimal(
        invoice.remainingAmount,
        application.amount,
        { ...moneyFormat, field: `invoice ${invoiceId} remaining balance` }
      ),
    });
  }

  if (compareDecimal(appliedAmount, request.payment.remainingAmount, moneyFormat) > 0) {
    throw new Error("applications exceed the payment remaining balance");
  }

  return PaymentAllocationPlanSchema.parse({
    paymentId: request.payment.id,
    paymentRemainingBefore: request.payment.remainingAmount,
    appliedAmount,
    paymentRemainingAfter: subtractDecimal(
      request.payment.remainingAmount,
      appliedAmount,
      { ...moneyFormat, field: "payment remaining balance" }
    ),
    applications: plannedApplications.toSorted((left, right) => left.invoiceId.localeCompare(right.invoiceId)),
  });
}
