import { randomUUID } from "node:crypto";
import {
  PaymentPageSchema,
  fingerprintPaginationFilters,
  formatPaginationCursor,
  parsePaginationCursor,
  type InvoiceStatus,
  type ListPaymentsV1Request,
  type PaymentPage,
  type PaginationCursorFailureCode,
  type TransmissionMethod,
  type TransmissionStatus,
} from "@meridian/contracts";
import { z } from "zod";
import { prisma } from "../db";
import {
  assertAccountingDateOpen,
  parseAccountingDate,
  type AccountingDate,
} from "../domain/accountingPeriod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  addDecimal,
  canonicalMoney,
  compareDecimal,
  decimalOrLegacy,
  legacyNumber,
  subtractDecimal,
  type CanonicalDecimal,
  type DecimalInput,
} from "../domain/money";
import { planPaymentAllocation, type PaymentAllocationPlan } from "../domain/paymentAllocation";
import {
  planPaymentApplicationReversal,
  type PaymentReversalPlan,
} from "../domain/paymentReversal";
import {
  ConflictError,
  DomainInvariantError,
  NotFoundError,
  PreconditionError,
} from "../errors";
import {
  PaymentModel,
  toPaymentApplicationReversalModel,
  toPaymentModel,
  type PaymentApplicationReversalModel,
} from "../models/payment";

const paymentInclude = {
  customer: true,
  applications: {
    include: { invoice: true, reversals: { orderBy: { createdAt: "asc" } } },
    orderBy: { appliedAt: "asc" },
  },
} as const;
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const zeroMoney = canonicalMoney("0");
const SERIALIZATION_ATTEMPTS = 3;

/** Existing clients have no currency field; their explicit temporary default is USD. */
export const DEFAULT_PAYMENT_CURRENCY = "USD";
export const PAYMENT_REVERSAL_ACTOR = "system:meridian-api";

interface LedgerAmount {
  readonly amount: number;
  readonly amountDecimal: DecimalInput | null;
  readonly reversals?: readonly ExactReversalAmount[];
}

export interface PaymentLedgerSnapshot extends LedgerAmount {
  readonly id: string;
  readonly customerId: string;
  readonly currencyCode: string | null;
  readonly applications: readonly LedgerAmount[];
}

export interface InvoiceLedgerSnapshot {
  readonly id: string;
  readonly customerId: string;
  readonly currencyCode: string | null;
  readonly status: InvoiceStatus;
  readonly total: number;
  readonly totalDecimal: DecimalInput | null;
  readonly amountPaid: number;
  readonly amountPaidDecimal: DecimalInput | null;
  readonly applications: readonly LedgerAmount[];
}

export interface PaymentApplicationWrite {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amount: number;
  readonly amountDecimal: CanonicalDecimal;
}

export interface InvoiceBalanceWrite {
  readonly invoiceId: string;
  readonly expectedAmountPaid: number;
  readonly expectedAmountPaidDecimal: CanonicalDecimal | null;
  readonly amountPaid: number;
  readonly amountPaidDecimal: CanonicalDecimal;
  readonly status: "POSTED" | "SENT" | "PAID";
}

export interface PaymentAllocationTransaction {
  loadPayment(paymentId: string): Promise<PaymentLedgerSnapshot>;
  loadInvoices(invoiceIds: readonly string[]): Promise<readonly InvoiceLedgerSnapshot[]>;
  /** Must persist every balance write and immutable application, or none of them. */
  persistAllocation(input: {
    readonly applications: readonly PaymentApplicationWrite[];
    readonly invoiceBalances: readonly InvoiceBalanceWrite[];
  }): Promise<boolean>;
}

export interface PaymentAllocationDependencies {
  transaction<T>(operation: (transaction: PaymentAllocationTransaction) => Promise<T>): Promise<T>;
}

export interface RecordPaymentInput {
  readonly customerId: string;
  readonly amount: DecimalInput;
  readonly reference?: string;
  readonly currencyCode?: string;
}

export interface PaymentRecordingDependencies {
  createPayment(input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly amount: number;
    readonly amountDecimal: CanonicalDecimal;
    readonly currencyCode: string;
    readonly reference?: string;
  }): Promise<{ id: string }>;
}

export class PaymentAllocationConflictError extends ConflictError {
  constructor() {
    super(
      "CONCURRENT_MODIFICATION",
      "Payment allocation conflicted with a concurrent balance update; reload and retry"
    );
    this.name = "PaymentAllocationConflictError";
  }
}

export class PaymentReversalConflictError extends ConflictError {
  constructor() {
    super(
      "CONCURRENT_MODIFICATION",
      "Payment reversal conflicted with a concurrent ledger update; reload and retry"
    );
    this.name = "PaymentReversalConflictError";
  }
}

function currencyCode(value: string | null | undefined): string {
  const code = value ?? DEFAULT_PAYMENT_CURRENCY;
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("payment currency must be an ISO 4217 code");
  return code;
}

function exactAmount(value: LedgerAmount, field: string): CanonicalDecimal {
  return decimalOrLegacy({ decimal: value.amountDecimal, legacy: value.amount }, { ...moneyFormat, field });
}

function sumApplicationAmounts(applications: readonly LedgerAmount[], field: string): CanonicalDecimal {
  return applications.reduce(
    (sum, application) => {
      const net = subtractDecimal(
        exactAmount(application, field),
        sumExactAmounts(
          application.reversals ?? [],
          `${field} reversal amount`
        ),
        { ...moneyFormat, field }
      );
      return addDecimal(sum, net, { ...moneyFormat, field });
    },
    zeroMoney
  );
}

function reconciledInvoice(invoice: InvoiceLedgerSnapshot): {
  readonly total: CanonicalDecimal;
  readonly paid: CanonicalDecimal;
  readonly balance: CanonicalDecimal;
} {
  const total = decimalOrLegacy(
    { decimal: invoice.totalDecimal, legacy: invoice.total },
    { ...moneyFormat, field: `invoice ${invoice.id} total` }
  );
  const paid = sumApplicationAmounts(invoice.applications, `invoice ${invoice.id} application amount`);
  const storedPaid = decimalOrLegacy(
    { decimal: invoice.amountPaidDecimal, legacy: invoice.amountPaid },
    { ...moneyFormat, field: `invoice ${invoice.id} amount paid` }
  );
  if (storedPaid !== paid) {
    throw new Error(`invoice ${invoice.id} amount paid is not reconciled to immutable applications`);
  }
  return {
    total,
    paid,
    balance: subtractDecimal(total, paid, { ...moneyFormat, field: `invoice ${invoice.id} balance` }),
  };
}

function isRetryableSerializationError(error: unknown): boolean {
  if (
    error instanceof PaymentAllocationConflictError ||
    error instanceof PaymentReversalConflictError
  ) {
    return true;
  }
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "P2034" || code === "40001";
}

interface ExactReversalAmount {
  readonly amountDecimal: DecimalInput;
}

export interface PaymentReversalSnapshot {
  readonly id: string;
  readonly paymentId: string;
  readonly amountDecimal: DecimalInput | null;
  readonly payment: {
    readonly customerId: string;
    readonly currencyCode: string | null;
  };
  readonly reversals: readonly ExactReversalAmount[];
  readonly invoice: {
    readonly id: string;
    readonly customerId: string;
    readonly currencyCode: string | null;
    readonly status: InvoiceStatus;
    readonly total: number;
    readonly totalDecimal: DecimalInput | null;
    readonly amountPaid: number;
    readonly amountPaidDecimal: DecimalInput | null;
    readonly applications: readonly (LedgerAmount & {
      readonly reversals: readonly ExactReversalAmount[];
    })[];
    readonly transmissions: readonly {
      readonly method: TransmissionMethod;
      readonly status: TransmissionStatus;
    }[];
  };
  readonly closedThroughDate: string | null;
}

export interface PaymentReversalWrite {
  readonly id: string;
  readonly paymentApplicationId: string;
  readonly amountDecimal: CanonicalDecimal;
  readonly reason: string;
  readonly accountingDate: AccountingDate;
  readonly actor: typeof PAYMENT_REVERSAL_ACTOR;
  readonly createdAt: Date;
}

export interface PaymentReversalInvoiceWrite {
  readonly invoiceId: string;
  readonly expectedAmountPaid: number;
  readonly expectedAmountPaidDecimal: CanonicalDecimal;
  readonly expectedStatus: InvoiceStatus;
  readonly amountPaid: number;
  readonly amountPaidDecimal: CanonicalDecimal;
  readonly status: "POSTED" | "SENT" | "PAID";
}

export interface PaymentReversalTransaction {
  loadApplication(applicationId: string): Promise<PaymentReversalSnapshot | null>;
  /** Inserts the reversal and CAS-updates its invoice, or atomically writes neither. */
  persistReversal(input: {
    readonly reversal: PaymentReversalWrite;
    readonly invoice: PaymentReversalInvoiceWrite;
  }): Promise<boolean>;
}

export interface PaymentReversalDependencies {
  transaction<T>(operation: (transaction: PaymentReversalTransaction) => Promise<T>): Promise<T>;
}

export interface ReversePaymentApplicationInput {
  readonly amount: DecimalInput;
  readonly reason: string;
  readonly accountingDate: string;
}

function requiredExactAmount(value: DecimalInput | null, field: string): CanonicalDecimal {
  if (value === null) {
    throw new PreconditionError(
      "PAYMENT_REVERSAL_BACKFILL_REQUIRED",
      `${field} must be backfilled before this application can be reversed`
    );
  }
  return canonicalMoney(value, field);
}

function sumExactAmounts(
  values: readonly ExactReversalAmount[],
  field: string
): CanonicalDecimal {
  return values.reduce(
    (sum, value) =>
      addDecimal(sum, canonicalMoney(value.amountDecimal, field), {
        ...moneyFormat,
        field,
      }),
    zeroMoney
  );
}

function successfulDelivery(
  transmissions: PaymentReversalSnapshot["invoice"]["transmissions"]
): boolean {
  return transmissions.some(
    ({ method, status }) =>
      (method === "EMAIL" && status === "SENT") ||
      (method === "PORTAL" && status === "DELIVERED") ||
      (method === "API" && status === "ACCEPTED")
  );
}

function requireOpenReversalDate(
  accountingDate: AccountingDate,
  closedThroughDate: string | null
): void {
  const parsedClose =
    closedThroughDate === null ? null : parseAccountingDate(closedThroughDate);
  try {
    assertAccountingDateOpen(accountingDate, parsedClose);
  } catch {
    throw new PreconditionError(
      "ACCOUNTING_PERIOD_CLOSED",
      `Accounting date ${accountingDate} is closed through ${parsedClose}`
    );
  }
}

export async function reversePaymentApplicationWithDependencies(
  paymentId: string,
  applicationId: string,
  input: ReversePaymentApplicationInput,
  dependencies: PaymentReversalDependencies
): Promise<{ readonly reversalId: string; readonly plan: PaymentReversalPlan }> {
  let amountDecimal: CanonicalDecimal;
  let accountingDate: AccountingDate;
  try {
    amountDecimal = canonicalMoney(input.amount, "payment reversal amount");
    accountingDate = parseAccountingDate(input.accountingDate);
  } catch {
    throw new DomainInvariantError(
      "PAYMENT_REVERSAL_INVALID",
      "The reversal amount and accounting date must be valid"
    );
  }
  if (compareDecimal(amountDecimal, zeroMoney, moneyFormat) <= 0) {
    throw new DomainInvariantError(
      "PAYMENT_REVERSAL_INVALID",
      "Payment reversal amount must be greater than zero"
    );
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 1_000) {
    throw new DomainInvariantError(
      "PAYMENT_REVERSAL_INVALID",
      "Payment reversal reason must contain 1-1000 characters"
    );
  }
  const reversal: PaymentReversalWrite = {
    id: randomUUID(),
    paymentApplicationId: applicationId,
    amountDecimal,
    reason,
    accountingDate,
    actor: PAYMENT_REVERSAL_ACTOR,
    createdAt: new Date(),
  };

  const plan = await withSerializationRetry(dependencies, async (transaction) => {
    const application = await transaction.loadApplication(applicationId);
    if (application === null || application.paymentId !== paymentId) {
      throw new NotFoundError(
        "PAYMENT_APPLICATION_NOT_FOUND",
        "The payment application was not found on this payment"
      );
    }
    if (
      application.payment.currencyCode === null ||
      application.invoice.currencyCode === null
    ) {
      throw new PreconditionError(
        "PAYMENT_REVERSAL_BACKFILL_REQUIRED",
        "Payment and invoice currency must be backfilled before reversal"
      );
    }
    if (
      application.payment.customerId !== application.invoice.customerId ||
      application.payment.currencyCode !== application.invoice.currencyCode
    ) {
      throw new DomainInvariantError(
        "PAYMENT_APPLICATION_COMMERCIAL_MISMATCH",
        "Payment and invoice customer and currency facts must match"
      );
    }
    requireOpenReversalDate(reversal.accountingDate, application.closedThroughDate);

    const applicationAmount = requiredExactAmount(
      application.amountDecimal,
      "payment application amount"
    );
    const invoiceTotal = requiredExactAmount(
      application.invoice.totalDecimal,
      "invoice total"
    );
    const storedInvoicePaid = requiredExactAmount(
      application.invoice.amountPaidDecimal,
      "invoice amount paid"
    );
    const applicationReversed = sumExactAmounts(
      application.reversals,
      "payment application reversed amount"
    );
    const grossApplied = application.invoice.applications.reduce(
      (sum, invoiceApplication) =>
        addDecimal(
          sum,
          requiredExactAmount(
            invoiceApplication.amountDecimal,
            "invoice payment application amount"
          ),
          { ...moneyFormat, field: "invoice gross applied amount" }
        ),
      zeroMoney
    );
    const invoiceReversed = application.invoice.applications.reduce(
      (sum, invoiceApplication) =>
        addDecimal(
          sum,
          sumExactAmounts(
            invoiceApplication.reversals,
            "invoice payment reversal amount"
          ),
          { ...moneyFormat, field: "invoice reversed amount" }
        ),
      zeroMoney
    );
    if (
      compareDecimal(applicationReversed, applicationAmount, moneyFormat) > 0 ||
      compareDecimal(invoiceReversed, grossApplied, moneyFormat) > 0
    ) {
      throw new DomainInvariantError(
        "PAYMENT_REVERSAL_INVALID",
        "Existing reversals exceed their immutable payment applications"
      );
    }
    const reconciledPaid = subtractDecimal(grossApplied, invoiceReversed, {
      ...moneyFormat,
      field: "invoice reconciled amount paid",
    });
    if (reconciledPaid !== storedInvoicePaid) {
      throw new Error(
        `invoice ${application.invoice.id} amount paid is not reconciled to applications and reversals`
      );
    }

    let planned: PaymentReversalPlan;
    try {
      planned = planPaymentApplicationReversal({
        requestedPaymentId: paymentId,
        amount: reversal.amountDecimal,
        application: {
          id: application.id,
          paymentId: application.paymentId,
          amount: applicationAmount,
          reversedAmount: applicationReversed,
          paymentCustomerId: application.payment.customerId,
          paymentCurrencyCode: application.payment.currencyCode,
          invoiceCustomerId: application.invoice.customerId,
          invoiceCurrencyCode: application.invoice.currencyCode,
        },
        invoice: {
          status: application.invoice.status,
          total: invoiceTotal,
          grossAppliedAmount: grossApplied,
          reversedAmount: invoiceReversed,
          hasSuccessfulDelivery: successfulDelivery(
            application.invoice.transmissions
          ),
        },
      });
    } catch (error) {
      if (error instanceof DomainInvariantError) throw error;
      throw new DomainInvariantError(
        "PAYMENT_REVERSAL_INVALID",
        "The reversal violates application, invoice, amount, or lifecycle rules"
      );
    }

    const persisted = await transaction.persistReversal({
      reversal,
      invoice: {
        invoiceId: application.invoice.id,
        expectedAmountPaid: application.invoice.amountPaid,
        expectedAmountPaidDecimal: storedInvoicePaid,
        expectedStatus: application.invoice.status,
        amountPaid: legacyNumber(planned.invoiceAmountPaidAfter, moneyFormat),
        amountPaidDecimal: planned.invoiceAmountPaidAfter,
        status: planned.invoiceStatusAfter,
      },
    });
    if (!persisted) throw new PaymentReversalConflictError();
    return planned;
  });

  return { reversalId: reversal.id, plan };
}

async function withSerializationRetry<T, Transaction>(
  dependencies: {
    transaction<Result>(
      operation: (transaction: Transaction) => Promise<Result>
    ): Promise<Result>;
  },
  operation: (transaction: Transaction) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.transaction(operation);
    } catch (error) {
      lastError = error;
      if (!isRetryableSerializationError(error) || attempt === SERIALIZATION_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}

function prepareAllocation(
  payment: PaymentLedgerSnapshot,
  invoices: readonly InvoiceLedgerSnapshot[],
  applications: readonly { invoiceId: string; amount: DecimalInput }[]
): {
  readonly plan: PaymentAllocationPlan;
  readonly applications: readonly PaymentApplicationWrite[];
  readonly invoiceBalances: readonly InvoiceBalanceWrite[];
} {
  const paymentAmount = exactAmount(payment, "payment amount");
  const paymentApplied = sumApplicationAmounts(payment.applications, "payment application amount");
  const paymentRemaining = subtractDecimal(paymentAmount, paymentApplied, {
    ...moneyFormat,
    field: "payment remaining balance",
  });
  const paymentCurrency = currencyCode(payment.currencyCode);
  const foundInvoiceIds = new Set(invoices.map((invoice) => invoice.id));
  if (applications.some((application) => !foundInvoiceIds.has(application.invoiceId))) {
    throw new NotFoundError(
      "PAYMENT_INVOICE_NOT_FOUND",
      "One or more invoices were not found for this payment"
    );
  }
  const invoicesById = new Map(invoices.map((invoice) => [invoice.id, { invoice, ...reconciledInvoice(invoice) }]));

  let plan: PaymentAllocationPlan;
  try {
    plan = planPaymentAllocation({
      payment: { id: payment.id, customerId: payment.customerId, currencyCode: paymentCurrency, remainingAmount: paymentRemaining },
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        customerId: invoice.customerId,
        currencyCode: currencyCode(invoice.currencyCode),
        status: invoice.status,
        remainingAmount: invoicesById.get(invoice.id)?.balance,
      })),
      applications: applications.map((application) => ({
        invoiceId: application.invoiceId,
        amount: canonicalMoney(application.amount, `application for invoice ${application.invoiceId}`),
      })),
    });
  } catch (error) {
    if (error instanceof DomainInvariantError || error instanceof NotFoundError) throw error;
    throw new DomainInvariantError(
      "PAYMENT_ALLOCATION_INVALID",
      "Payment allocation violates customer, currency, lifecycle, amount, or balance rules"
    );
  }

  const applicationWrites = plan.applications.map((application) => ({
    paymentId: payment.id,
    invoiceId: application.invoiceId,
    amount: legacyNumber(application.amount, moneyFormat),
    amountDecimal: application.amount,
  }));
  const invoiceBalanceWrites: InvoiceBalanceWrite[] = plan.applications.map((application) => {
    const existing = invoicesById.get(application.invoiceId);
    if (!existing) throw new Error(`invoice ${application.invoiceId} disappeared during allocation`);
    const amountPaidDecimal = addDecimal(existing.paid, application.amount, moneyFormat);
    return {
      invoiceId: application.invoiceId,
      expectedAmountPaid: existing.invoice.amountPaid,
      expectedAmountPaidDecimal:
        existing.invoice.amountPaidDecimal === null
          ? null
          : decimalOrLegacy(
              {
                decimal: existing.invoice.amountPaidDecimal,
                legacy: existing.invoice.amountPaid,
              },
              { ...moneyFormat, field: `invoice ${application.invoiceId} amount paid` }
            ),
      amountPaid: legacyNumber(amountPaidDecimal, moneyFormat),
      amountPaidDecimal,
      status:
        compareDecimal(amountPaidDecimal, existing.total, moneyFormat) === 0
          ? "PAID"
          : existing.invoice.status === "SENT"
            ? "SENT"
            : "POSTED",
    };
  });
  return { plan, applications: applicationWrites, invoiceBalances: invoiceBalanceWrites };
}

export async function applyPaymentWithDependencies(
  paymentId: string,
  applications: readonly { invoiceId: string; amount: DecimalInput }[],
  dependencies: PaymentAllocationDependencies
): Promise<PaymentAllocationPlan> {
  return withSerializationRetry(dependencies, async (transaction) => {
    const payment = await transaction.loadPayment(paymentId);
    const invoices = await transaction.loadInvoices(applications.map((application) => application.invoiceId));
    const prepared = prepareAllocation(payment, invoices, applications);
    if (!(await transaction.persistAllocation(prepared))) throw new PaymentAllocationConflictError();
    return prepared.plan;
  });
}

export async function createPaymentWithDependencies(
  tenantId: string,
  input: RecordPaymentInput,
  dependencies: PaymentRecordingDependencies
): Promise<{ id: string }> {
  const amountDecimal = canonicalMoney(input.amount, "payment amount");
  return dependencies.createPayment({
    tenantId,
    customerId: input.customerId,
    amount: legacyNumber(amountDecimal, moneyFormat),
    amountDecimal,
    currencyCode: currencyCode(input.currencyCode),
    reference: input.reference,
  });
}

export async function listPayments(tenantId: string): Promise<PaymentModel[]> {
  const rows = await prisma.payment.findMany({
    where: { tenantId },
    include: paymentInclude,
    orderBy: { receivedAt: "desc" },
    take: 100,
  });
  return rows.map(toPaymentModel);
}

const PaymentCursorOrderingSchema = z.tuple([
  z.iso.datetime({ offset: true }),
  z.string().min(1).max(1_024),
]);

export type PaymentPageResult =
  | { readonly ok: true; readonly page: PaymentPage }
  | { readonly ok: false; readonly code: PaginationCursorFailureCode };

/**
 * Lists a v1 payment page with a tenant-scoped keyset predicate. The cursor
 * intentionally contains only public filtering/order state; authentication is
 * the sole source of tenant scope for every page, including cursor replays.
 */
export async function listPaymentsPage(
  tenantId: string,
  query: ListPaymentsV1Request["query"]
): Promise<PaymentPageResult> {
  const filterFingerprint = fingerprintPaginationFilters({
    customerId: query.customerId,
  });
  const parsedCursor = query.cursor === undefined
    ? undefined
    : parsePaginationCursor(query.cursor, { resource: "payments", filterFingerprint });
  if (parsedCursor !== undefined && !parsedCursor.ok) return parsedCursor;

  const ordering = parsedCursor === undefined
    ? undefined
    : PaymentCursorOrderingSchema.safeParse(parsedCursor.ordering);
  if (ordering !== undefined && !ordering.success) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }

  const [receivedAt, id] = ordering === undefined ? [] : ordering.data;
  const rows = await prisma.payment.findMany({
    where: {
      tenantId,
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(receivedAt === undefined || id === undefined
        ? {}
        : {
            OR: [
              { receivedAt: { lt: new Date(receivedAt) } },
              { receivedAt: new Date(receivedAt), id: { lt: id } },
            ],
          }),
    },
    include: paymentInclude,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > query.limit && lastRow !== undefined
    ? formatPaginationCursor({
        resource: "payments",
        filterFingerprint,
        ordering: [lastRow.receivedAt.toISOString(), lastRow.id],
      })
    : null;
  return {
    ok: true,
    page: PaymentPageSchema.parse({
      data: pageRows.map(toPaymentModel),
      page: { limit: query.limit, nextCursor },
    }),
  };
}

export async function getPayment(tenantId: string, paymentId: string): Promise<PaymentModel> {
  const row = await prisma.payment.findFirst({
    where: { id: paymentId, tenantId },
    include: paymentInclude,
  });
  if (row === null) {
    throw new NotFoundError("PAYMENT_NOT_FOUND", "The payment was not found");
  }
  return toPaymentModel(row);
}

export async function recordPayment(tenantId: string, input: RecordPaymentInput): Promise<PaymentModel> {
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, tenantId },
    select: { id: true },
  });
  if (customer === null) {
    throw new NotFoundError("PAYMENT_CUSTOMER_NOT_FOUND", "The payment customer was not found");
  }
  const payment = await createPaymentWithDependencies(tenantId, input, {
    createPayment: (data) => prisma.payment.create({ data }),
  });
  return getPayment(tenantId, payment.id);
}

function prismaAllocationDependencies(tenantId: string): PaymentAllocationDependencies {
  return {
    transaction: (operation) =>
      prisma.$transaction(
        async (transaction) =>
          operation({
            async loadPayment(paymentId) {
              const payment = await transaction.payment.findFirst({
                where: { id: paymentId, tenantId },
                include: { applications: { include: { reversals: true } } },
              });
              if (payment === null) {
                throw new NotFoundError("PAYMENT_NOT_FOUND", "The payment was not found");
              }
              return payment;
            },
            loadInvoices: (invoiceIds) =>
              transaction.invoice.findMany({
                where: { id: { in: [...invoiceIds] }, tenantId },
                include: { applications: { include: { reversals: true } } },
              }),
            persistAllocation: async ({ applications, invoiceBalances }) => {
              await transaction.paymentApplication.createMany({ data: [...applications] });
              for (const invoice of invoiceBalances) {
                const updated = await transaction.invoice.updateMany({
                  where: {
                    id: invoice.invoiceId,
                    tenantId,
                    amountPaid: invoice.expectedAmountPaid,
                    amountPaidDecimal: invoice.expectedAmountPaidDecimal,
                  },
                  data: { amountPaid: invoice.amountPaid, amountPaidDecimal: invoice.amountPaidDecimal, status: invoice.status },
                });
                if (updated.count !== 1) return false;
              }
              return true;
            },
          }),
        { isolationLevel: "Serializable" }
      ),
  };
}

export async function applyPayment(
  tenantId: string,
  paymentId: string,
  applications: readonly { invoiceId: string; amount: DecimalInput }[]
): Promise<PaymentModel> {
  await applyPaymentWithDependencies(paymentId, applications, prismaAllocationDependencies(tenantId));
  return getPayment(tenantId, paymentId);
}

function prismaReversalDependencies(tenantId: string): PaymentReversalDependencies {
  return {
    transaction: (operation) =>
      prisma.$transaction(
        async (transaction) =>
          operation({
            async loadApplication(applicationId) {
              const [application, control] = await Promise.all([
                transaction.paymentApplication.findFirst({
                  where: {
                    id: applicationId,
                    payment: { tenantId },
                    invoice: { tenantId },
                  },
                  include: {
                    payment: true,
                    reversals: true,
                    invoice: {
                      include: {
                        applications: { include: { reversals: true } },
                        transmissions: true,
                      },
                    },
                  },
                }),
                transaction.tenantAccountingPeriodControl.findUnique({
                  where: { tenantId },
                }),
              ]);
              if (application === null) return null;
              return {
                ...application,
                closedThroughDate: control?.closedThroughDate ?? null,
              };
            },
            async persistReversal({ reversal, invoice }) {
              await transaction.paymentApplicationReversal.create({
                data: reversal,
              });
              const updated = await transaction.invoice.updateMany({
                where: {
                  id: invoice.invoiceId,
                  tenantId,
                  amountPaid: invoice.expectedAmountPaid,
                  amountPaidDecimal: invoice.expectedAmountPaidDecimal,
                  status: invoice.expectedStatus,
                },
                data: {
                  amountPaid: invoice.amountPaid,
                  amountPaidDecimal: invoice.amountPaidDecimal,
                  status: invoice.status,
                },
              });
              return updated.count === 1;
            },
          }),
        { isolationLevel: "Serializable" }
      ),
  };
}

export async function reversePaymentApplication(
  tenantId: string,
  paymentId: string,
  applicationId: string,
  input: ReversePaymentApplicationInput
): Promise<PaymentApplicationReversalModel> {
  const { reversalId } = await reversePaymentApplicationWithDependencies(
    paymentId,
    applicationId,
    input,
    prismaReversalDependencies(tenantId)
  );
  const row = await prisma.paymentApplicationReversal.findFirst({
    where: {
      id: reversalId,
      paymentApplication: {
        payment: { tenantId },
        invoice: { tenantId },
      },
    },
  });
  if (row === null) throw new NotFoundError("PAYMENT_APPLICATION_NOT_FOUND", "The payment application was not found on this payment");
  return toPaymentApplicationReversalModel(row);
}
