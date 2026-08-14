import type { Invoice, InvoiceLine, Payment, PaymentApplication, Transmission } from "@prisma/client";
import { toTransmissionModel, TransmissionModel } from "./transmission";

export interface InvoiceLineModel {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoicePaymentModel {
  id: string;
  paymentId: string;
  amount: number;
  receivedAt: string;
  reference: string | null;
}

export interface InvoiceModel {
  id: string;
  number: string;
  customerId: string;
  customerName?: string;
  customerEmail?: string;
  billingAddress?: string | null;
  orderId: string;
  orderReference?: string | null;
  status: string;
  issueDate: string;
  dueDate: string;
  total: number;
  amountPaid: number;
  balance: number;
  postedAt: string | null;
  lines: InvoiceLineModel[];
  payments: InvoicePaymentModel[];
  transmissions: TransmissionModel[];
  lastTransmission: TransmissionModel | null;
}

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
  return {
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
  };
}
