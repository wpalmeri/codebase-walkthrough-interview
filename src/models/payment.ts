import type {
  Payment,
  PaymentApplication,
  PaymentApplicationReversal,
} from "@prisma/client";
import {
  PaymentApplicationReversalSchema,
  PaymentSchema,
  type Payment as ContractPayment,
  type PaymentApplicationReversal as ContractPaymentApplicationReversal,
} from "@meridian/contracts";
import {
  addDecimal,
  decimalOrLegacy,
  legacyNumber,
  MONEY_PRECISION,
  MONEY_SCALE,
  subtractDecimal,
} from "../domain/money";

export type PaymentModel = ContractPayment;

type PaymentRow = Payment & {
  customer?: { name: string };
  applications?: (PaymentApplication & {
    invoice?: { number: string };
    reversals?: PaymentApplicationReversal[];
  })[];
};

export type PaymentApplicationReversalModel = ContractPaymentApplicationReversal;

export function toPaymentApplicationReversalModel(
  row: PaymentApplicationReversal
): PaymentApplicationReversalModel {
  const amountDecimal = decimalOrLegacy(
    { decimal: row.amountDecimal, legacy: null },
    { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment reversal amount" }
  );
  return PaymentApplicationReversalSchema.parse({
    id: row.id,
    paymentApplicationId: row.paymentApplicationId,
    amount: legacyNumber(amountDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "payment reversal amount",
    }),
    amountDecimal,
    reason: row.reason,
    accountingDate: row.accountingDate,
    actor: row.actor,
    createdAt: row.createdAt.toISOString(),
  });
}

export function toPaymentModel(row: PaymentRow): PaymentModel {
  const applications = (row.applications ?? []).map((application) => {
    const amountDecimal = decimalOrLegacy(
      { decimal: application.amountDecimal, legacy: application.amount },
      { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment application amount" }
    );
    const reversals = (application.reversals ?? []).map(
      toPaymentApplicationReversalModel
    );
    const reversedAmountDecimal = reversals.reduce(
      (sum, reversal) =>
        addDecimal(sum, reversal.amountDecimal, {
          scale: MONEY_SCALE,
          precision: MONEY_PRECISION,
          field: "payment application reversed amount",
        }),
      "0.0000"
    );
    const netAmountDecimal = subtractDecimal(
      amountDecimal,
      reversedAmountDecimal,
      {
        scale: MONEY_SCALE,
        precision: MONEY_PRECISION,
        field: "payment application net amount",
      }
    );
    return {
      id: application.id,
      invoiceId: application.invoiceId,
      invoiceNumber: application.invoice?.number,
      amount: legacyNumber(amountDecimal, {
        scale: MONEY_SCALE,
        precision: MONEY_PRECISION,
        field: "payment application amount",
      }),
      amountDecimal,
      reversedAmount: legacyNumber(reversedAmountDecimal, {
        scale: MONEY_SCALE,
        precision: MONEY_PRECISION,
        field: "payment application reversed amount",
      }),
      reversedAmountDecimal,
      netAmount: legacyNumber(netAmountDecimal, {
        scale: MONEY_SCALE,
        precision: MONEY_PRECISION,
        field: "payment application net amount",
      }),
      netAmountDecimal,
      appliedAt: application.appliedAt.toISOString(),
      reversals,
    };
  });
  const amountDecimal = decimalOrLegacy(
    { decimal: row.amountDecimal, legacy: row.amount },
    { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment amount" }
  );
  const appliedDecimal = applications.reduce(
    (sum, application) =>
      addDecimal(sum, application.netAmountDecimal, {
        scale: MONEY_SCALE,
        precision: MONEY_PRECISION,
        field: "payment applied amount",
      }),
    "0.0000"
  );
  const unappliedDecimal = subtractDecimal(amountDecimal, appliedDecimal, {
    scale: MONEY_SCALE,
    precision: MONEY_PRECISION,
    field: "payment unapplied amount",
  });
  return PaymentSchema.parse({
    id: row.id,
    customerId: row.customerId,
    customerName: row.customer?.name,
    amount: legacyNumber(amountDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "payment amount",
    }),
    amountDecimal,
    currencyCode: row.currencyCode ?? undefined,
    receivedAt: row.receivedAt.toISOString(),
    reference: row.reference,
    applied: legacyNumber(appliedDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "payment applied amount",
    }),
    unapplied: legacyNumber(unappliedDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "payment unapplied amount",
    }),
    appliedDecimal,
    unappliedDecimal,
    applications,
  });
}
