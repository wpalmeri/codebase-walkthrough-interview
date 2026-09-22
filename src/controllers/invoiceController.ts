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
import {
  ApplicationError,
  ConflictError,
  DomainInvariantError,
  NotFoundError,
  PreconditionError,
} from "../errors";
import {
  formatResourceEtag,
  verifyResourceIfMatch,
  type ResourceVersionPreconditionFailure,
} from "../http/resourceVersion";
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
import {
  appendRequestAuditEvent,
  type RequestAuditAppender,
  type RequestAuditMetadata,
  RequestAuditMetadataSchema,
} from "../audit/requestAudit";
import type { AuditEventRepository } from "../audit/auditEvent";

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
  tenantId: string,
  accountingDate: AccountingDate
): Promise<void> {
  const control = await transaction.tenantAccountingPeriodControl.findUnique({
    where: { tenantId },
  });
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
  tenantId: string;
  invoiceId: string;
  method: TransmissionMethod;
}

interface FailedTransmissionInput {
  tenantId: string;
  invoiceId: string;
  method: TransmissionMethod;
  externalJobId?: string;
  detail: string;
}

export interface InvoiceDeliveryDependencies {
  findInvoice(tenantId: string, invoiceId: string): Promise<DeliverableInvoice>;
  renderPdf(invoice: Parameters<typeof renderInvoicePdf>[0]): Buffer;
  sendEmail(to: string, invoiceNumber: string, pdf: Buffer): TransmissionResult;
  createPortalJob(portalAccount: string, invoiceNumber: string): TransmissionResult;
  submitToClearinghouse(clearinghouseId: string, invoiceNumber: string): TransmissionResult;
  attachDocument(method: TransmissionMethod, reference: string, pdf: Buffer): void;
  recordSuccessfulTransmission(input: TransmissionRecordInput): Promise<void>;
  recordFailedTransmission(input: FailedTransmissionInput): Promise<void>;
  getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceModel>;
}

/** Request-derived evidence required by invoice mutations exposed to API routes. */
export interface InvoiceMutationAudit {
  readonly metadata: RequestAuditMetadata;
  /** Injectable only to prove transaction rollback when audit persistence fails. */
  readonly append?: RequestAuditAppender;
}

type InvoiceAuditTransaction = Pick<
  Prisma.TransactionClient,
  "invoice" | "transmission" | "auditEvent"
>;

export async function listInvoices(tenantId: string): Promise<InvoiceModel[]> {
  const rows = await prisma.invoice.findMany({
    where: { tenantId },
    include: invoiceInclude,
    orderBy: { issueDate: "desc" },
  });
  return rows.map(toInvoiceModel);
}

export async function getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceModel> {
  const row = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId, tenantId },
    include: invoiceInclude,
  });
  return toInvoiceModel(row);
}

export async function getVersionedInvoice(
  tenantId: string,
  invoiceId: string
): Promise<{ invoice: InvoiceModel; etag: string }> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: invoiceInclude,
  });
  if (invoice === null) throw new NotFoundError();
  return {
    invoice: toInvoiceModel(invoice),
    etag: formatResourceEtag({
      kind: "invoice",
      id: invoice.id,
      version: invoice.resourceVersion ?? 0,
    }),
  };
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

export async function createInvoiceForOrder(
  tenantId: string,
  orderId: string,
  audit: InvoiceMutationAudit
): Promise<InvoiceModel> {
  assertInvoiceAuditTenant(tenantId, audit);
  const invoiceId = await prisma.$transaction(async (transaction) => {
    const order = await transaction.order.findFirstOrThrow({
      where: { id: orderId, tenantId },
      include: { customer: true, items: { include: { product: true } } },
    });
    const existing = await transaction.invoice.findFirst({ where: { orderId, tenantId } });
    if (existing) return existing.id;
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
        tenantId,
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
      where: { id: orderId, tenantId, status: "OPEN" },
      data: { status: "INVOICED" },
    });
    if (updated.count !== 1) {
      throw new ConflictError("ORDER_NOT_OPEN", "Only an OPEN order can be invoiced");
    }
    await appendInvoiceAudit(transaction, audit, {
      action: "INVOICE_CREATED",
      resourceKind: "INVOICE",
      resourceId: id,
    });
    await appendInvoiceAudit(transaction, audit, {
      action: "ORDER_INVOICED",
      resourceKind: "ORDER",
      resourceId: order.id,
    });
    return id;
  });
  return getInvoice(tenantId, invoiceId);
}

// Update the invoice's dates.
export async function updateInvoice(
  tenantId: string,
  invoiceId: string,
  input: { issueDate?: string; dueDate?: string },
  audit: InvoiceMutationAudit
): Promise<InvoiceModel> {
  assertInvoiceAuditTenant(tenantId, audit);
  await prisma.$transaction(async (transaction) => {
    const invoice = await transaction.invoice.findFirstOrThrow({ where: { id: invoiceId, tenantId } });
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
      await requireOpenAccountingDate(
        transaction,
        tenantId,
        parseAccountingDate(accountingDate)
      );
    }
    const updated = await transaction.invoice.updateMany({
      where: { id: invoiceId, tenantId, status: "DRAFT" },
      data: { issueDate, dueDate, accountingDate },
    });
    if (updated.count !== 1) {
      throw new ConflictError(
        "CONCURRENT_MODIFICATION",
        "Invoice changed concurrently; reload and retry"
      );
    }
    await appendInvoiceAudit(transaction, audit, {
      action: "INVOICE_UPDATED",
      resourceKind: "INVOICE",
      resourceId: invoice.id,
    });
  });
  return getInvoice(tenantId, invoiceId);
}

/** v1 CAS variant; acquire the root version before validating/mutating dates. */
export async function updateInvoiceConditionally(
  tenantId: string,
  invoiceId: string,
  input: { issueDate?: string; dueDate?: string },
  ifMatch: string | undefined,
  audit: InvoiceMutationAudit
): Promise<{ invoice: InvoiceModel; etag: string }> {
  assertInvoiceAuditTenant(tenantId, audit);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.invoice.findFirst({
      where: { id: invoiceId, tenantId },
    });
    if (existing === null) throw new NotFoundError();
    const version = existing.resourceVersion ?? 0;
    const precondition = verifyResourceIfMatch(
      ifMatch,
      { kind: "invoice", id: existing.id },
      version
    );
    if (!precondition.ok) throwInvoicePrecondition(precondition);
    if (version === Number.MAX_SAFE_INTEGER) {
      throw new PreconditionError(
        "RESOURCE_VERSION_EXHAUSTED",
        "This resource version cannot be advanced safely"
      );
    }
    const acquired = await transaction.invoice.updateMany({
      where: {
        id: existing.id,
        tenantId,
        ...(existing.resourceVersion === null
          ? { resourceVersion: null }
          : { resourceVersion: version }),
      },
      data: { resourceVersion: version + 1 },
    });
    if (acquired.count !== 1) {
      throw new PreconditionError(
        "ETAG_VERSION_MISMATCH",
        "If-Match does not match the current resource version"
      );
    }
    if (existing.status !== "DRAFT") {
      throw new ConflictError("INVOICE_NOT_DRAFT", "Only a DRAFT invoice can be redated");
    }
    const issueDate = input.issueDate === undefined ? existing.issueDate : new Date(input.issueDate);
    const dueDate = input.dueDate === undefined ? existing.dueDate : new Date(input.dueDate);
    if (dueDate < issueDate) {
      throw new DomainInvariantError(
        "INVOICE_DATE_RANGE_INVALID",
        "Invoice due date must be on or after issue date"
      );
    }
    const accountingDate =
      input.issueDate === undefined
        ? existing.accountingDate
        : utcAccountingDateFromInstant(issueDate);
    if (accountingDate !== null) {
      await requireOpenAccountingDate(transaction, tenantId, parseAccountingDate(accountingDate));
    }
    const updated = await transaction.invoice.updateMany({
      where: { id: invoiceId, tenantId, status: "DRAFT" },
      data: { issueDate, dueDate, accountingDate },
    });
    if (updated.count !== 1) {
      throw new ConflictError(
        "CONCURRENT_MODIFICATION",
        "Invoice changed concurrently; reload and retry"
      );
    }
    await appendInvoiceAudit(transaction, audit, {
      action: "INVOICE_UPDATED",
      resourceKind: "INVOICE",
      resourceId: existing.id,
    });
    const final = await transaction.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: invoiceInclude,
    });
    if (final === null) throw new NotFoundError();
    return {
      invoice: toInvoiceModel(final),
      etag: formatResourceEtag({
        kind: "invoice",
        id: final.id,
        version: final.resourceVersion ?? 0,
      }),
    };
  });
}

function throwInvoicePrecondition(failure: ResourceVersionPreconditionFailure): never {
  if (failure.status === 412) throw new PreconditionError(failure.code, failure.detail);
  throw new ApplicationError({
    type:
      failure.status === 428
        ? "urn:meridian:problem:precondition-required"
        : "urn:meridian:problem:invalid-if-match",
    title: failure.status === 428 ? "Precondition Required" : "Bad Request",
    status: failure.status,
    code: failure.code,
    detail: failure.detail,
  });
}

// Draft invoices copy materialized order snapshots. The delete/create pair is
// deliberately enclosed by the caller's transaction, so readers see all old
// lines or all new lines and never a partially rebuilt draft.
export async function syncDraftInvoiceInTransaction(
  transaction: InvoiceTransaction,
  tenantId: string,
  orderId: string
): Promise<void> {
  const invoice = await transaction.invoice.findFirst({ where: { orderId, tenantId } });
  if (!invoice || invoice.status !== "DRAFT") return;

  const order = await transaction.order.findFirstOrThrow({
    where: { id: orderId, tenantId },
    include: { customer: true, items: { include: { product: true } } },
  });
  const lines = order.items.map(invoiceLineData);
  const totalDecimal = invoiceTotal(lines);
  await transaction.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } });
  const updated = await transaction.invoice.updateMany({
    where: { id: invoice.id, tenantId, status: "DRAFT" },
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

export async function syncDraftInvoice(tenantId: string, orderId: string): Promise<void> {
  await prisma.$transaction((transaction) => syncDraftInvoiceInTransaction(transaction, tenantId, orderId));
}

// Posting copies order snapshots one final time and freezes the invoice. It is
// idempotent for already-finalized non-void invoices.
export async function postInvoice(
  tenantId: string,
  invoiceId: string,
  audit: InvoiceMutationAudit
): Promise<InvoiceModel> {
  assertInvoiceAuditTenant(tenantId, audit);
  await prisma.$transaction(async (transaction) => {
    const invoice = await transaction.invoice.findFirstOrThrow({ where: { id: invoiceId, tenantId } });
    if (["POSTED", "SENT", "PAID"].includes(invoice.status)) return;
    if (invoice.status !== "DRAFT") {
      throw new ConflictError("INVOICE_NOT_POSTABLE", "Only a DRAFT invoice can be posted");
    }

    const order = await transaction.order.findFirstOrThrow({
      where: { id: invoice.orderId, tenantId },
      include: { customer: true, items: { include: { product: true } } },
    });
    const lines = order.items.map(invoiceLineData);
    const totalDecimal = invoiceTotal(lines);
    const accountingDate =
      invoice.accountingDate === null
        ? utcAccountingDateFromInstant(invoice.issueDate)
        : parseAccountingDate(invoice.accountingDate);
    await requireOpenAccountingDate(transaction, tenantId, accountingDate);
    await transaction.invoiceLine.deleteMany({ where: { invoiceId } });
    await transaction.invoice.update({ where: { id: invoiceId }, data: { lines: { create: lines } } });
    const updated = await transaction.invoice.updateMany({
      where: { id: invoiceId, tenantId, status: "DRAFT" },
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
    await appendInvoiceAudit(transaction, audit, {
      action: "INVOICE_POSTED",
      resourceKind: "INVOICE",
      resourceId: invoice.id,
    });
  });
  return getInvoice(tenantId, invoiceId);
}

function invoiceDeliveryDependencies(audit: InvoiceMutationAudit): InvoiceDeliveryDependencies {
  return {
  async findInvoice(tenantId, invoiceId) {
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { id: invoiceId, tenantId },
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
    await prisma.$transaction(async (transaction) => {
      const transmission = await transaction.transmission.create({
        data: {
          invoiceId: input.invoiceId,
          method: input.method,
          status: input.status,
          externalJobId: input.externalJobId ?? null,
          detail: input.detail,
        },
      });
      const updated = await transaction.invoice.updateMany({
        where: { id: input.invoiceId, tenantId: input.tenantId },
        data: { status: "SENT" },
      });
      if (updated.count !== 1) throw new NotFoundError();
      await appendInvoiceAudit(transaction, audit, {
        action: "INVOICE_SENT",
        resourceKind: "INVOICE",
        resourceId: input.invoiceId,
      });
      await appendInvoiceAudit(transaction, audit, {
        action: "INVOICE_DELIVERY_REQUESTED",
        resourceKind: "INVOICE_DELIVERY",
        resourceId: transmission.id,
      });
    });
  },
  async recordFailedTransmission(input) {
    await prisma.$transaction(async (transaction) => {
      const invoice = await transaction.invoice.findFirst({
        where: { id: input.invoiceId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (invoice === null) throw new NotFoundError();
      const transmission = await transaction.transmission.create({
        data: {
          invoiceId: input.invoiceId,
          method: input.method,
          status: "FAILED",
          externalJobId: input.externalJobId ?? null,
          detail: input.detail,
        },
      });
      await appendInvoiceAudit(transaction, audit, {
        action: "INVOICE_DELIVERY_REQUESTED",
        resourceKind: "INVOICE_DELIVERY",
        resourceId: transmission.id,
      });
    });
  },
  getInvoice,
  };
}

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
  tenantId: string,
  invoiceId: string,
  rawMethod: string,
  dependencies: InvoiceDeliveryDependencies
): Promise<InvoiceModel> {
  const method = TransmissionMethodSchema.parse(rawMethod);
  const invoice = await dependencies.findInvoice(tenantId, invoiceId);
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
      tenantId,
      invoiceId,
      method,
      ...result,
    });
  } catch (error) {
    return recordDeliveryFailure(
      dependencies,
      {
        tenantId,
        invoiceId,
        method,
        externalJobId: result?.externalJobId,
        detail: safeFailureDetail(stage, error),
      },
      error
    );
  }

  return dependencies.getInvoice(tenantId, invoiceId);
}

export async function sendInvoice(
  tenantId: string,
  invoiceId: string,
  method: string,
  audit: InvoiceMutationAudit
): Promise<InvoiceModel> {
  assertInvoiceAuditTenant(tenantId, audit);
  return sendInvoiceWithDependencies(tenantId, invoiceId, method, invoiceDeliveryDependencies(audit));
}

// Poll the external portal service and refresh the job status.
export async function refreshTransmission(
  tenantId: string,
  transmissionId: string,
  audit: InvoiceMutationAudit
): Promise<TransmissionModel> {
  assertInvoiceAuditTenant(tenantId, audit);
  return prisma.$transaction(async (transaction) => {
    const transmission = await transaction.transmission.findFirstOrThrow({
      where: { id: transmissionId, invoice: { tenantId } },
    });
    if (transmission.method === "PORTAL" && transmission.status !== "DELIVERED") {
      const status = checkPortalJob(transmission.createdAt);
      if (status === transmission.status) return toTransmissionModel(transmission);
      const updated = await transaction.transmission.updateMany({
        where: { id: transmissionId, invoice: { tenantId } },
        data: { status },
      });
      if (updated.count !== 1) throw new NotFoundError();
      await appendInvoiceAudit(transaction, audit, {
        action: "INVOICE_DELIVERY_UPDATED",
        resourceKind: "INVOICE_DELIVERY",
        resourceId: transmission.id,
      });
      return toTransmissionModel({ ...transmission, status });
    }
    return toTransmissionModel(transmission);
  });
}

function assertInvoiceAuditTenant(tenantId: string, audit: InvoiceMutationAudit): void {
  const metadata = RequestAuditMetadataSchema.parse(audit.metadata);
  if (metadata.tenantId !== tenantId) {
    throw new Error("invoice audit tenant must match the authenticated tenant");
  }
}

async function appendInvoiceAudit(
  transaction: InvoiceAuditTransaction,
  audit: InvoiceMutationAudit,
  event: Parameters<RequestAuditAppender>[2]
): Promise<void> {
  await (audit.append ?? appendRequestAuditEvent)(
    auditEventRepository(transaction),
    audit.metadata,
    event
  );
}

function auditEventRepository(
  transaction: Pick<Prisma.TransactionClient, "auditEvent">
): AuditEventRepository {
  return {
    auditEvent: {
      create: ({ data }) => transaction.auditEvent.create({ data }),
    },
  };
}
