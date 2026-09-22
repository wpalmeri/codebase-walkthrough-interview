import type { Payment, PaymentApplication } from "@prisma/client";
import { PaymentSchema, type Payment as ContractPayment } from "@meridian/contracts";
import {
  addDecimal,
  decimalOrLegacy,
  MONEY_PRECISION,
  MONEY_SCALE,
  subtractDecimal,
} from "../domain/money";

export type PaymentModel = ContractPayment;

type PaymentRow = Payment & {
  customer?: { name: string };
  applications?: (PaymentApplication & { invoice?: { number: string } })[];
};

export function toPaymentModel(row: PaymentRow): PaymentModel {
  const applications = (row.applications ?? []).map((application) => {
    const amountDecimal = decimalOrLegacy(
      { decimal: application.amountDecimal, legacy: application.amount },
      { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment application amount" }
    );
    return {
      id: application.id,
      invoiceId: application.invoiceId,
      invoiceNumber: application.invoice?.number,
      amount: Number(amountDecimal),
      amountDecimal,
      appliedAt: application.appliedAt.toISOString(),
    };
  });
  const amountDecimal = decimalOrLegacy(
    { decimal: row.amountDecimal, legacy: row.amount },
    { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment amount" }
  );
  const appliedDecimal = applications.reduce(
    (sum, application) =>
      addDecimal(sum, application.amountDecimal, {
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
    amount: Number(amountDecimal),
    amountDecimal,
    currencyCode: row.currencyCode ?? undefined,
    receivedAt: row.receivedAt.toISOString(),
    reference: row.reference,
    applied: Number(appliedDecimal),
    unapplied: Number(unappliedDecimal),
    appliedDecimal,
    unappliedDecimal,
    applications,
  });
}
