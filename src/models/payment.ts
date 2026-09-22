import type { Payment, PaymentApplication } from "@prisma/client";
import { PaymentSchema, type Payment as ContractPayment } from "@meridian/contracts";

export type PaymentModel = ContractPayment;

type PaymentRow = Payment & {
  customer?: { name: string };
  applications?: (PaymentApplication & { invoice?: { number: string } })[];
};

export function toPaymentModel(row: PaymentRow): PaymentModel {
  const applications = (row.applications ?? []).map((application) => ({
    id: application.id,
    invoiceId: application.invoiceId,
    invoiceNumber: application.invoice?.number,
    amount: application.amount,
    appliedAt: application.appliedAt.toISOString(),
  }));
  const applied = applications.reduce((sum, application) => sum + application.amount, 0);
  return PaymentSchema.parse({
    id: row.id,
    customerId: row.customerId,
    customerName: row.customer?.name,
    amount: row.amount,
    receivedAt: row.receivedAt.toISOString(),
    reference: row.reference,
    applied,
    unapplied: row.amount - applied,
    applications,
  });
}
