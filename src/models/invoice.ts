import type { Invoice, InvoiceLine, Payment, PaymentApplication, Transmission } from "@prisma/client";
import { InvoiceSchema, type Invoice as ContractInvoice } from "@meridian/contracts";
import { toTransmissionModel } from "./transmission";

export type InvoiceModel = ContractInvoice;

type InvoiceRow = Invoice & {
  customer?: { name: string; email: string; billingAddress: string | null };
  order?: { reference: string | null };
  lines?: InvoiceLine[];
  applications?: (PaymentApplication & { payment?: Payment })[];
  transmissions?: Transmission[];
};

export function toInvoiceModel(row: InvoiceRow): InvoiceModel {
  const transmissions = row.transmissions ?? [];
  const last = transmissions.length > 0 ? transmissions[transmissions.length - 1] : null;
  return InvoiceSchema.parse({
    id: row.id,
    number: row.number,
    customerId: row.customerId,
    customerName: row.customer?.name,
    customerEmail: row.customer?.email,
    billingAddress: row.customer?.billingAddress,
    orderId: row.orderId,
    orderReference: row.order?.reference,
    status: row.status,
    issueDate: row.issueDate.toISOString(),
    dueDate: row.dueDate.toISOString(),
    total: row.total,
    amountPaid: row.amountPaid,
    balance: row.total - row.amountPaid,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    lines: (row.lines ?? []).map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
    })),
    payments: (row.applications ?? []).map((application) => ({
      id: application.id,
      paymentId: application.paymentId,
      amount: application.amount,
      receivedAt: (application.payment?.receivedAt ?? application.appliedAt).toISOString(),
      reference: application.payment?.reference ?? null,
    })),
    transmissions: transmissions.map(toTransmissionModel),
    lastTransmission: last ? toTransmissionModel(last) : null,
  });
}
