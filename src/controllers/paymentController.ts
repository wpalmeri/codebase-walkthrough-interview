import { prisma } from "../db";
import { PaymentModel, toPaymentModel } from "../models/payment";

const paymentInclude = {
  customer: true,
  applications: { include: { invoice: true }, orderBy: { appliedAt: "asc" } },
} as const;

export async function listPayments(): Promise<PaymentModel[]> {
  const rows = await prisma.payment.findMany({
    include: paymentInclude,
    orderBy: { receivedAt: "desc" },
    take: 100,
  });
  return rows.map(toPaymentModel);
}

export async function getPayment(paymentId: string): Promise<PaymentModel> {
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: paymentInclude,
  });
  return toPaymentModel(row);
}

// Step 1: record the cash as received from a customer.
export async function recordPayment(input: {
  customerId: string;
  amount: number;
  reference?: string;
}): Promise<PaymentModel> {
  const payment = await prisma.payment.create({
    data: {
      customerId: input.customerId,
      amount: input.amount,
      reference: input.reference,
    },
  });
  return getPayment(payment.id);
}

// Step 2: apply a payment across one or more invoices.
export async function applyPayment(
  paymentId: string,
  applications: { invoiceId: string; amount: number }[]
): Promise<PaymentModel> {
  for (const application of applications) {
    if (!application.amount) continue;
    await prisma.paymentApplication.create({
      data: {
        paymentId,
        invoiceId: application.invoiceId,
        amount: application.amount,
      },
    });
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: application.invoiceId },
    });
    const amountPaid = invoice.amountPaid + application.amount;
    await prisma.invoice.update({
      where: { id: application.invoiceId },
      data: {
        amountPaid,
        status: amountPaid >= invoice.total ? "PAID" : invoice.status,
      },
    });
  }
  return getPayment(paymentId);
}
