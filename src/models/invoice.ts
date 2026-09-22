import type {
  Invoice,
  InvoiceLine,
  Payment,
  PaymentApplication,
  PaymentApplicationReversal,
  Transmission,
} from "@prisma/client";
import { InvoiceSchema, type Invoice as ContractInvoice } from "@meridian/contracts";
import {
  addDecimal,
  decimalOrLegacy,
  legacyNumber,
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  subtractDecimal,
} from "../domain/money";
import { toTransmissionModel } from "./transmission";
import { toPaymentApplicationReversalModel } from "./payment";

export type InvoiceModel = ContractInvoice;

type InvoiceRow = Invoice & {
  customer?: { name: string; email: string; billingAddress: string | null };
  order?: { reference: string | null };
  lines?: InvoiceLine[];
  applications?: (PaymentApplication & {
    payment?: Payment;
    reversals?: PaymentApplicationReversal[];
  })[];
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
    accountingDate: row.accountingDate ?? undefined,
    total: legacyNumber(totalDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "invoice total",
    }),
    amountPaid: legacyNumber(amountPaidDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "invoice amount paid",
    }),
    totalDecimal,
    amountPaidDecimal,
    currencyCode: row.currencyCode ?? undefined,
    balance: legacyNumber(balanceDecimal, {
      scale: MONEY_SCALE,
      precision: MONEY_PRECISION,
      field: "invoice balance",
    }),
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
        quantity: legacyNumber(quantityDecimal, {
          scale: QUANTITY_SCALE,
          precision: QUANTITY_PRECISION,
          field: "invoice line quantity",
        }),
        unitPrice: legacyNumber(unitPriceDecimal, {
          scale: MONEY_SCALE,
          precision: MONEY_PRECISION,
          field: "invoice line unit price",
        }),
        amount: legacyNumber(amountDecimal, {
          scale: MONEY_SCALE,
          precision: MONEY_PRECISION,
          field: "invoice line amount",
        }),
        quantityDecimal,
        unitPriceDecimal,
        amountDecimal,
      };
    }),
    payments: (row.applications ?? []).map((application) => {
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
        { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "payment application net amount" }
      );
      return {
        id: application.id,
        paymentId: application.paymentId,
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
        receivedAt: (application.payment?.receivedAt ?? application.appliedAt).toISOString(),
        reference: application.payment?.reference ?? null,
        reversals,
      };
    }),
    transmissions: transmissions.map(toTransmissionModel),
    lastTransmission: last ? toTransmissionModel(last) : null,
  });
}
