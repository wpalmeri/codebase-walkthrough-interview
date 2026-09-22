import type { Invoice, InvoiceLine, Payment, PaymentApplication, Transmission } from "@prisma/client";
import { InvoiceSchema, type Invoice as ContractInvoice } from "@meridian/contracts";
import {
  decimalOrLegacy,
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  subtractDecimal,
} from "../domain/money";
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
  const totalDecimal = decimalOrLegacy(
    { decimal: row.totalDecimal, legacy: row.total },
    { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "invoice total" }
  );
  const amountPaidDecimal = decimalOrLegacy(
    { decimal: row.amountPaidDecimal, legacy: row.amountPaid },
    { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "invoice amount paid" }
  );
  const balanceDecimal = subtractDecimal(totalDecimal, amountPaidDecimal, {
    scale: MONEY_SCALE,
    precision: MONEY_PRECISION,
    field: "invoice balance",
  });
  return InvoiceSchema.parse({
    id: row.id,
    number: row.number,
    customerId: row.customerId,
    customerName: row.customerNameSnapshot ?? row.customer?.name,
    customerEmail: row.customerEmailSnapshot ?? row.customer?.email,
    billingAddress: row.billingAddressSnapshot ?? row.customer?.billingAddress,
    orderId: row.orderId,
    orderReference: row.order?.reference,
    status: row.status,
    issueDate: row.issueDate.toISOString(),
    dueDate: row.dueDate.toISOString(),
    total: Number(totalDecimal),
    amountPaid: Number(amountPaidDecimal),
    totalDecimal,
    amountPaidDecimal,
    currencyCode: row.currencyCode ?? undefined,
    balance: Number(balanceDecimal),
    balanceDecimal,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    lines: (row.lines ?? []).map((line) => {
      const quantityDecimal = decimalOrLegacy(
        { decimal: line.quantityDecimal, legacy: line.quantity },
        { scale: QUANTITY_SCALE, precision: QUANTITY_PRECISION, field: "invoice line quantity" }
      );
      const unitPriceDecimal = decimalOrLegacy(
        { decimal: line.unitPriceDecimal, legacy: line.unitPrice },
        { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "invoice line unit price" }
      );
      const amountDecimal = decimalOrLegacy(
        { decimal: line.amountDecimal, legacy: line.amount },
        { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "invoice line amount" }
      );
      return {
        id: line.id,
        description: line.description,
        quantity: Number(quantityDecimal),
        unitPrice: Number(unitPriceDecimal),
        amount: Number(amountDecimal),
        quantityDecimal,
        unitPriceDecimal,
        amountDecimal,
      };
    }),
    payments: (row.applications ?? []).map((application) => ({
      id: application.id,
      paymentId: application.paymentId,
      amount: Number(
        decimalOrLegacy(
          { decimal: application.amountDecimal, legacy: application.amount },
          { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment application amount" }
        )
      ),
      amountDecimal: decimalOrLegacy(
        { decimal: application.amountDecimal, legacy: application.amount },
        { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment application amount" }
      ),
      receivedAt: (application.payment?.receivedAt ?? application.appliedAt).toISOString(),
      reference: application.payment?.reference ?? null,
    })),
    transmissions: transmissions.map(toTransmissionModel),
    lastTransmission: last ? toTransmissionModel(last) : null,
  });
}
