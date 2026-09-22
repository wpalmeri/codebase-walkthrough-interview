import {
  EmailAddressSchema,
  TransmissionMethodSchema,
  type TransmissionMethod,
  type TransmissionStatus,
} from "@meridian/contracts";
import { randomUUID } from "node:crypto";
import { Prisma, type OrderItem, type Product } from "@prisma/client";
import { prisma } from "../db";
import {
  assertAccountingDateOpen,
  parseAccountingDate,
  utcAccountingDateFromInstant,
  type AccountingDate,
} from "../domain/accountingPeriod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  addDecimal,
  canonicalMoney,
  decimalOrLegacy,
  legacyNumber,
  type DecimalInput,
} from "../domain/money";
import { productSubtotal } from "../domain/pricing";
import { ConflictError, DomainInvariantError, PreconditionError } from "../errors";
import { InvoiceModel, toInvoiceModel } from "../models/invoice";
import { toTransmissionModel, TransmissionModel } from "../models/transmission";
import { renderInvoicePdf } from "../services/pdf";
import {
  attachDocument,
  checkPortalJob,
  createPortalJob,
  sendEmail,
  submitToClearinghouse,
} from "../services/transmission";

const invoiceInclude = {
  customer: true,
  order: true,
  lines: true,
  applications: {
    include: { payment: true, reversals: { orderBy: { createdAt: "asc" } } },
    orderBy: { appliedAt: "asc" },
  },
  transmissions: { orderBy: { createdAt: "asc" } },
} as const;

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const quantityFormat = {
  scale: QUANTITY_SCALE,
  precision: QUANTITY_PRECISION,
  field: "quantity",
} as const;
type InvoiceTransaction = Prisma.TransactionClient;
type InvoiceSourceItem = OrderItem & { product: Product };

async function requireOpenAccountingDate(
  transaction: InvoiceTransaction,
  accountingDate: AccountingDate
): Promise<void> {
  const control = await transaction.accountingPeriodControl.findUnique({ where: { id: 1 } });
  const closedThroughDate =
    control?.closedThroughDate === null || control?.closedThroughDate === undefined
      ? null
      : parseAccountingDate(control.closedThroughDate);
  try {
    assertAccountingDateOpen(accountingDate, closedThroughDate);
  } catch {
    throw new PreconditionError(
      "ACCOUNTING_PERIOD_CLOSED",
      `Accounting date ${accountingDate} is closed through ${closedThroughDate}`
    );
  }
}

interface DeliverableInvoice {
  id: string;
  number: string;
  status: string;
  issueDate: Date;
  dueDate: Date;
  total: number;
  totalDecimal?: DecimalInput | null;
  customerNameSnapshot?: string | null;
  customerEmailSnapshot?: string | null;
  billingAddressSnapshot?: string | null;
  customer: {
    name: string;
    email: string;
    billingAddress: string | null;
    portalAccount: string | null;
    clearinghouseId: string | null;
  };
  lines: {
    description: string;
    quantity: number;
    quantityDecimal?: DecimalInput | null;
    unitPrice: number;
    unitPriceDecimal?: DecimalInput | null;
    amount: number;
    amountDecimal?: DecimalInput | null;
  }[];
}

interface TransmissionResult {
  status: TransmissionStatus;
  detail: string;
  externalJobId?: string;
}

interface TransmissionRecordInput extends TransmissionResult {
  invoiceId: string;
  method: TransmissionMethod;
}

interface FailedTransmissionInput {
  invoiceId: string;
  method: TransmissionMethod;
  externalJobId?: string;
  detail: string;
}

export interface InvoiceDeliveryDependencies {
  findInvoice(invoiceId: string): Promise<DeliverableInvoice>;
  renderPdf(invoice: Parameters<typeof renderInvoicePdf>[0]): Buffer;
  sendEmail(to: string, invoiceNumber: string, pdf: Buffer): TransmissionResult;
  createPortalJob(portalAccount: string, invoiceNumber: string): TransmissionResult;
  submitToClearinghouse(clearinghouseId: string, invoiceNumber: string): TransmissionResult;
  attachDocument(method: TransmissionMethod, reference: string, pdf: Buffer): void;
  recordSuccessfulTransmission(input: TransmissionRecordInput): Promise<void>;
  recordFailedTransmission(input: FailedTransmissionInput): Promise<void>;
  getInvoice(invoiceId: string): Promise<InvoiceModel>;
}

export async function listInvoices(): Promise<InvoiceModel[]> {
  const rows = await prisma.invoice.findMany({
    include: invoiceInclude,
    orderBy: { issueDate: "desc" },
  });
  return rows.map(toInvoiceModel);
}

export async function getInvoice(invoiceId: string): Promise<InvoiceModel> {
  const row = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: invoiceInclude,
  });
  return toInvoiceModel(row);
}

function invoiceNumber(id: string): string {
  return `INV-${id.toUpperCase()}`;
}

function invoiceLineData(item: InvoiceSourceItem) {
  const quantityDecimal = decimalOrLegacy(
    { decimal: item.quantityDecimal, legacy: item.quantity },
    { ...quantityFormat, field: `order item ${item.id} quantity` }
  );
  const unitPriceDecimal = decimalOrLegacy(
    { decimal: item.effectiveUnitPriceDecimal, legacy: item.unitPrice },
    { ...moneyFormat, field: `order item ${item.id} unit price` }
  );
  const amountDecimal =
    item.amountDecimal === null
      ? canonicalMoney(
          productSubtotal(unitPriceDecimal, quantityDecimal),
          `order item ${item.id} amount`
        )
      : canonicalMoney(item.amountDecimal, `order item ${item.id} amount`);
  return {
    description: `${item.productNameSnapshot ?? item.product.name} @ ${item.productUnitSnapshot ?? item.product.unit}`,
    quantity: legacyNumber(quantityDecimal, quantityFormat),
    unitPrice: legacyNumber(unitPriceDecimal, moneyFormat),
    amount: legacyNumber(amountDecimal, moneyFormat),
    productSkuSnapshot: item.productSkuSnapshot ?? item.product.sku,
    productUnitSnapshot: item.productUnitSnapshot ?? item.product.unit,
    quantityDecimal,
    unitPriceDecimal,
    amountDecimal,
  };
}

function invoiceTotal(lines: readonly ReturnType<typeof invoiceLineData>[]): string {
  return lines.reduce(
    (sum, line) => addDecimal(sum, line.amountDecimal, { ...moneyFormat, field: "invoice total" }),
    canonicalMoney("0", "invoice total")
  );
}

export async function createInvoiceForOrder(orderId: string): Promise<InvoiceModel> {
  const invoiceId = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.invoice.findUnique({ where: { orderId } });
    if (existing) return existing.id;

    const order = await transaction.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { customer: true, items: { include: { product: true } } },
    });
    if (order.items.length === 0) {
      throw new DomainInvariantError(
        "ORDER_ITEMS_REQUIRED",
        "An invoice requires at least one order item"
      );
    }
    const lines = order.items.map(invoiceLineData);
    const totalDecimal = invoiceTotal(lines);
    const id = randomUUID();
    const issueDate = new Date();
    const accountingDate = utcAccountingDateFromInstant(issueDate);
    const dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    await transaction.invoice.create({
      data: {
        id,
        number: invoiceNumber(id),
        customerId: order.customerId,
        orderId,
        issueDate,
        dueDate,
        accountingDate,
        total: legacyNumber(totalDecimal, moneyFormat),
        totalDecimal,
        amountPaid: 0,
        amountPaidDecimal: canonicalMoney("0"),
        customerNameSnapshot: order.customer.name,
        customerEmailSnapshot: order.customer.email,
        billingAddressSnapshot: order.customer.billingAddress,
        currencyCode: order.currencyCode,
        lines: { create: lines },
      },
    });
    const updated = await transaction.order.updateMany({
      where: { id: orderId, status: "OPEN" },
      data: { status: "INVOICED" },
    });
    if (updated.count !== 1) {
      throw new ConflictError("ORDER_NOT_OPEN", "Only an OPEN order can be invoiced");
    }
    return id;
  });
  return getInvoice(invoiceId);
}

// Update the invoice's dates.
export async function updateInvoice(
  invoiceId: string,
  input: { issueDate?: string; dueDate?: string }
): Promise<InvoiceModel> {
  await prisma.$transaction(async (transaction) => {
    const invoice = await transaction.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (invoice.status !== "DRAFT") {
      throw new ConflictError("INVOICE_NOT_DRAFT", "Only a DRAFT invoice can be redated");
    }
    const issueDate = input.issueDate === undefined ? invoice.issueDate : new Date(input.issueDate);
    const dueDate = input.dueDate === undefined ? invoice.dueDate : new Date(input.dueDate);
    if (dueDate < issueDate) {
      throw new DomainInvariantError(
        "INVOICE_DATE_RANGE_INVALID",
        "Invoice due date must be on or after issue date"
      );
    }
    const accountingDate =
      input.issueDate === undefined
        ? invoice.accountingDate
        : utcAccountingDateFromInstant(issueDate);
    if (accountingDate !== null) {
      await requireOpenAccountingDate(transaction, parseAccountingDate(accountingDate));
    }
    const updated = await transaction.invoice.updateMany({
      where: { id: invoiceId, status: "DRAFT" },
      data: { issueDate, dueDate, accountingDate },
    });
    if (updated.count !== 1) {
      throw new ConflictError(
        "CONCURRENT_MODIFICATION",
        "Invoice changed concurrently; reload and retry"
      );
    }
  });
  return getInvoice(invoiceId);
}

// Draft invoices copy materialized order snapshots. The delete/create pair is
// deliberately enclosed by the caller's transaction, so readers see all old
// lines or all new lines and never a partially rebuilt draft.
export async function syncDraftInvoiceInTransaction(
  transaction: InvoiceTransaction,
  orderId: string
): Promise<void> {
  const invoice = await transaction.invoice.findUnique({ where: { orderId } });
  if (!invoice || invoice.status !== "DRAFT") return;

  const order = await transaction.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { product: true } } },
  });
  const lines = order.items.map(invoiceLineData);
  const totalDecimal = invoiceTotal(lines);
  await transaction.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } });
  const updated = await transaction.invoice.updateMany({
    where: { id: invoice.id, status: "DRAFT" },
    data: {
      customerId: order.customerId,
      total: legacyNumber(totalDecimal, moneyFormat),
      totalDecimal,
      customerNameSnapshot: order.customer.name,
      customerEmailSnapshot: order.customer.email,
      billingAddressSnapshot: order.customer.billingAddress,
      currencyCode: order.currencyCode,
    },
  });
  if (updated.count !== 1) {
    throw new ConflictError(
      "CONCURRENT_MODIFICATION",
      "Draft invoice changed concurrently; reload and retry"
    );
  }
  await transaction.invoice.update({
    where: { id: invoice.id },
    data: {
      lines: { create: lines },
    },
  });
}

export async function syncDraftInvoice(orderId: string): Promise<void> {
  await prisma.$transaction((transaction) => syncDraftInvoiceInTransaction(transaction, orderId));
}

// Posting copies order snapshots one final time and freezes the invoice. It is
// idempotent for already-finalized non-void invoices.
export async function postInvoice(invoiceId: string): Promise<InvoiceModel> {
  await prisma.$transaction(async (transaction) => {
    const invoice = await transaction.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (["POSTED", "SENT", "PAID"].includes(invoice.status)) return;
    if (invoice.status !== "DRAFT") {
      throw new ConflictError("INVOICE_NOT_POSTABLE", "Only a DRAFT invoice can be posted");
    }

    const order = await transaction.order.findUniqueOrThrow({
      where: { id: invoice.orderId },
      include: { customer: true, items: { include: { product: true } } },
    });
    const lines = order.items.map(invoiceLineData);
    const totalDecimal = invoiceTotal(lines);
    const accountingDate =
      invoice.accountingDate === null
        ? utcAccountingDateFromInstant(invoice.issueDate)
        : parseAccountingDate(invoice.accountingDate);
    await requireOpenAccountingDate(transaction, accountingDate);
    await transaction.invoiceLine.deleteMany({ where: { invoiceId } });
    await transaction.invoice.update({ where: { id: invoiceId }, data: { lines: { create: lines } } });
    const updated = await transaction.invoice.updateMany({
      where: { id: invoiceId, status: "DRAFT" },
      data: {
        status: "POSTED",
        postedAt: new Date(),
        accountingDate,
        customerId: order.customerId,
        total: legacyNumber(totalDecimal, moneyFormat),
        totalDecimal,
        customerNameSnapshot: order.customer.name,
        customerEmailSnapshot: order.customer.email,
        billingAddressSnapshot: order.customer.billingAddress,
        currencyCode: order.currencyCode,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictError(
        "CONCURRENT_MODIFICATION",
        "Invoice changed concurrently while posting; reload and retry"
      );
    }
  });
  return getInvoice(invoiceId);
}

const defaultInvoiceDeliveryDependencies: InvoiceDeliveryDependencies = {
  async findInvoice(invoiceId) {
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { customer: true, lines: true },
    });
    return invoice;
  },
  renderPdf: renderInvoicePdf,
  sendEmail,
  createPortalJob,
  submitToClearinghouse,
  attachDocument,
  async recordSuccessfulTransmission(input) {
    await prisma.$transaction([
      prisma.transmission.create({
        data: {
          invoiceId: input.invoiceId,
          method: input.method,
          status: input.status,
          externalJobId: input.externalJobId ?? null,
          detail: input.detail,
        },
      }),
      prisma.invoice.update({ where: { id: input.invoiceId }, data: { status: "SENT" } }),
    ]);
  },
  async recordFailedTransmission(input) {
    await prisma.transmission.create({
      data: {
        invoiceId: input.invoiceId,
        method: input.method,
        status: "FAILED",
        externalJobId: input.externalJobId ?? null,
        detail: input.detail,
      },
    });
  },
  getInvoice,
};

type DeliveryStage = "recipient validation" | "PDF rendering" | "delivery" | "attachment" | "state recording";

function requiredDestination(value: string | null, label: string): string {
  if (!value?.trim()) {
    throw new PreconditionError(
      "DELIVERY_DESTINATION_MISSING",
      `${label} is not configured`
    );
  }
  return value;
}

function safeFailureDetail(stage: DeliveryStage, error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected delivery error";
  const safeMessage = message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 300);
  return `Invoice transmission failed during ${stage}${safeMessage ? `: ${safeMessage}` : ""}`;
}

async function recordDeliveryFailure(
  dependencies: InvoiceDeliveryDependencies,
  input: FailedTransmissionInput,
  deliveryError: unknown
): Promise<never> {
  try {
    await dependencies.recordFailedTransmission(input);
  } catch (recordingError) {
    throw new AggregateError(
      [deliveryError, recordingError],
      "Invoice delivery failed and its failure could not be recorded",
      { cause: recordingError }
    );
  }
  throw deliveryError;
}

export async function sendInvoiceWithDependencies(
  invoiceId: string,
  rawMethod: string,
  dependencies: InvoiceDeliveryDependencies
): Promise<InvoiceModel> {
  const method = TransmissionMethodSchema.parse(rawMethod);
  const invoice = await dependencies.findInvoice(invoiceId);
  if (invoice.status !== "POSTED" && invoice.status !== "SENT") {
    throw new ConflictError(
      "INVOICE_NOT_DELIVERABLE",
      `Invoice ${invoice.number} must be POSTED or SENT before transmission (current status: ${invoice.status})`
    );
  }

  let stage: DeliveryStage = "recipient validation";
  let result: TransmissionResult | undefined;
  try {
    const customerName = invoice.customerNameSnapshot ?? invoice.customer.name;
    const customerEmail = invoice.customerEmailSnapshot ?? invoice.customer.email;
    const billingAddress = invoice.billingAddressSnapshot ?? invoice.customer.billingAddress;

    let destination: string;
    if (method === "EMAIL") {
      const parsedEmail = EmailAddressSchema.safeParse(customerEmail);
      if (!parsedEmail.success) {
        throw new PreconditionError(
          "DELIVERY_RECIPIENT_INVALID",
          "The invoice delivery email is invalid"
        );
      }
      destination = parsedEmail.data;
    } else if (method === "PORTAL") {
      destination = requiredDestination(invoice.customer.portalAccount, "Portal account");
    } else {
      destination = requiredDestination(
        invoice.customer.clearinghouseId,
        "Clearinghouse identifier"
      );
    }

    stage = "PDF rendering";
    const pdf = dependencies.renderPdf({
      number: invoice.number,
      customerName,
      billingAddress,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      total: invoice.total,
      lines: invoice.lines,
    });

    stage = "delivery";
    if (method === "EMAIL") {
      result = dependencies.sendEmail(destination, invoice.number, pdf);
    } else if (method === "PORTAL") {
      result = dependencies.createPortalJob(destination, invoice.number);
      stage = "attachment";
      dependencies.attachDocument(method, result.externalJobId ?? invoice.number, pdf);
    } else {
      result = dependencies.submitToClearinghouse(destination, invoice.number);
      stage = "attachment";
      dependencies.attachDocument(method, result.externalJobId ?? invoice.number, pdf);
    }

    stage = "state recording";
    await dependencies.recordSuccessfulTransmission({
      invoiceId,
      method,
      ...result,
    });
  } catch (error) {
    return recordDeliveryFailure(
      dependencies,
      {
        invoiceId,
        method,
        externalJobId: result?.externalJobId,
        detail: safeFailureDetail(stage, error),
      },
      error
    );
  }

  return dependencies.getInvoice(invoiceId);
}

export async function sendInvoice(invoiceId: string, method: string): Promise<InvoiceModel> {
  return sendInvoiceWithDependencies(invoiceId, method, defaultInvoiceDeliveryDependencies);
}

// Poll the external portal service and refresh the job status.
export async function refreshTransmission(transmissionId: string): Promise<TransmissionModel> {
  const transmission = await prisma.transmission.findUniqueOrThrow({
    where: { id: transmissionId },
  });
  if (transmission.method === "PORTAL" && transmission.status !== "DELIVERED") {
    const status = checkPortalJob(transmission.createdAt);
    const updated = await prisma.transmission.update({
      where: { id: transmissionId },
      data: { status },
    });
    return toTransmissionModel(updated);
  }
  return toTransmissionModel(transmission);
}
