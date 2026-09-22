import { prisma } from "../db";
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
import { ConflictError, DomainInvariantError, NotFoundError } from "../errors";
import { PaymentModel, toPaymentModel } from "../models/payment";

const paymentInclude = {
  customer: true,
  applications: { include: { invoice: true }, orderBy: { appliedAt: "asc" } },
} as const;
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const zeroMoney = canonicalMoney("0");
const SERIALIZATION_ATTEMPTS = 3;

/** Existing clients have no currency field; their explicit temporary default is USD. */
export const DEFAULT_PAYMENT_CURRENCY = "USD";

interface LedgerAmount {
  readonly amount: number;
  readonly amountDecimal: DecimalInput | null;
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
  readonly status: string;
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
    (sum, application) => addDecimal(sum, exactAmount(application, field), { ...moneyFormat, field }),
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
  if (error instanceof PaymentAllocationConflictError) return true;
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "P2034" || code === "40001";
}

async function withSerializationRetry<T>(
  dependencies: PaymentAllocationDependencies,
  operation: (transaction: PaymentAllocationTransaction) => Promise<T>
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
  input: RecordPaymentInput,
  dependencies: PaymentRecordingDependencies
): Promise<{ id: string }> {
  const amountDecimal = canonicalMoney(input.amount, "payment amount");
  return dependencies.createPayment({
    customerId: input.customerId,
    amount: legacyNumber(amountDecimal, moneyFormat),
    amountDecimal,
    currencyCode: currencyCode(input.currencyCode),
    reference: input.reference,
  });
}

export async function listPayments(): Promise<PaymentModel[]> {
  const rows = await prisma.payment.findMany({ include: paymentInclude, orderBy: { receivedAt: "desc" }, take: 100 });
  return rows.map(toPaymentModel);
}

export async function getPayment(paymentId: string): Promise<PaymentModel> {
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: paymentInclude });
  return toPaymentModel(row);
}

export async function recordPayment(input: RecordPaymentInput): Promise<PaymentModel> {
  const payment = await createPaymentWithDependencies(input, {
    createPayment: (data) => prisma.payment.create({ data }),
  });
  return getPayment(payment.id);
}

function prismaAllocationDependencies(): PaymentAllocationDependencies {
  return {
    transaction: (operation) =>
      prisma.$transaction(
        async (transaction) =>
          operation({
            loadPayment: (paymentId) => transaction.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { applications: true } }),
            loadInvoices: (invoiceIds) =>
              transaction.invoice.findMany({ where: { id: { in: [...invoiceIds] } }, include: { applications: true } }),
            persistAllocation: async ({ applications, invoiceBalances }) => {
              for (const invoice of invoiceBalances) {
                const updated = await transaction.invoice.updateMany({
                  where: { id: invoice.invoiceId, amountPaid: invoice.expectedAmountPaid, amountPaidDecimal: invoice.expectedAmountPaidDecimal },
                  data: { amountPaid: invoice.amountPaid, amountPaidDecimal: invoice.amountPaidDecimal, status: invoice.status },
                });
                if (updated.count !== 1) return false;
              }
              await transaction.paymentApplication.createMany({ data: [...applications] });
              return true;
            },
          }),
        { isolationLevel: "Serializable" }
      ),
  };
}

export async function applyPayment(
  paymentId: string,
  applications: readonly { invoiceId: string; amount: DecimalInput }[]
): Promise<PaymentModel> {
  await applyPaymentWithDependencies(paymentId, applications, prismaAllocationDependencies());
  return getPayment(paymentId);
}
