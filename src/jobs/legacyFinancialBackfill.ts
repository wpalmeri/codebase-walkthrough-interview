import { ExactRateTierSchema } from "@meridian/contracts";
import { z } from "zod";
import { prisma } from "../db";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  addDecimal,
  canonicalMoney,
  canonicalPercentage,
  compareDecimal,
  type DecimalInput,
} from "../domain/money";
import { parseRateTiers, serializeRateTiers } from "../domain/rateTier";
import {
  runFinancialBackfill,
  FinancialBackfillResultSchema,
  type BackfillTransformResult,
  type FinancialBackfillRepository,
  type FinancialBackfillResult,
  type FinancialBackfillRow,
} from "./financialBackfill";

const USD = "USD";
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "backfill amount" } as const;
const zeroMoney = canonicalMoney("0");

export const PRODUCT_FINANCIAL_BACKFILL_JOB = "legacy-product-financial-v1";
export const RATE_FINANCIAL_BACKFILL_JOB = "legacy-rate-financial-v1";
export const DISCOUNT_FINANCIAL_BACKFILL_JOB = "legacy-discount-financial-v1";
export const PAYMENT_FINANCIAL_BACKFILL_JOB = "legacy-payment-financial-v1";
export const PAYMENT_APPLICATION_FINANCIAL_BACKFILL_JOB = "legacy-payment-application-financial-v1";

type SourceError = { readonly sourceError?: string };

export interface ProductFinancialBackfillSource extends FinancialBackfillRow, SourceError {
  listPrice: number;
  listPriceDecimal: DecimalInput | null;
  currencyCode: string | null;
}

export interface ProductFinancialBackfillWrite {
  readonly id: string;
  readonly listPriceDecimal: string;
  readonly currencyCode: typeof USD;
}

export interface RateFinancialBackfillSource extends FinancialBackfillRow, SourceError {
  unitPrice: number;
  unitPriceDecimal: DecimalInput | null;
  currencyCode: string | null;
  productCurrencyCode: string | null;
  tiers: unknown;
}

export interface RateFinancialBackfillWrite {
  readonly id: string;
  readonly unitPriceDecimal: string;
  readonly currencyCode: typeof USD;
  readonly tiers: ReturnType<typeof serializeRateTiers>;
}

export interface DiscountFinancialBackfillSource extends FinancialBackfillRow, SourceError {
  percentOff: number;
  percentOffDecimal: DecimalInput | null;
}

export interface DiscountFinancialBackfillWrite {
  readonly id: string;
  readonly percentOffDecimal: string;
}

interface InvoiceApplicationFact {
  readonly id: string;
  readonly amount: number;
  readonly amountDecimal: DecimalInput | null;
}

interface InvoiceFact {
  readonly id: string;
  readonly customerId: string;
  readonly currencyCode: string | null;
  readonly total: number;
  readonly totalDecimal: DecimalInput | null;
  readonly amountPaid: number;
  readonly amountPaidDecimal: DecimalInput | null;
  readonly applications: readonly InvoiceApplicationFact[];
}

interface PaymentApplicationFact {
  readonly id: string;
  readonly amount: number;
  readonly amountDecimal: DecimalInput | null;
  readonly invoice: InvoiceFact;
}

export interface PaymentFinancialBackfillSource extends FinancialBackfillRow, SourceError {
  customerId: string;
  amount: number;
  amountDecimal: DecimalInput | null;
  currencyCode: string | null;
  applications: readonly PaymentApplicationFact[];
}

export interface PaymentFinancialBackfillWrite {
  readonly id: string;
  readonly amountDecimal: string;
  readonly currencyCode: typeof USD;
}

export interface PaymentApplicationFinancialBackfillSource extends FinancialBackfillRow, SourceError {
  amount: number;
  amountDecimal: DecimalInput | null;
  payment: {
    readonly id: string;
    readonly customerId: string;
    readonly currencyCode: string | null;
    readonly amount: number;
    readonly amountDecimal: DecimalInput | null;
    readonly applications: readonly PaymentApplicationFact[];
  };
  invoice: InvoiceFact;
}

export interface PaymentApplicationFinancialBackfillWrite {
  readonly id: string;
  readonly amountDecimal: string;
}

const LegacyFinancialBackfillResultSchema = z.strictObject({
  state: z.enum(["COMPLETE", "PARTIAL"]),
  dryRun: z.boolean(),
  stages: z.array(
    z.strictObject({
      name: z.string().min(1),
      result: FinancialBackfillResultSchema,
    })
  ),
});
export type LegacyFinancialBackfillResult = z.infer<
  typeof LegacyFinancialBackfillResultSchema
>;

class UnsafeSourceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function unsafe<Write>(code: string, detail: string): BackfillTransformResult<Write> {
  return { kind: "unsafe", code, detail };
}

function sourceFailure(source: SourceError): BackfillTransformResult<never> | undefined {
  return source.sourceError === undefined
    ? undefined
    : unsafe("UNREPRESENTABLE_LEGACY_DECIMAL", source.sourceError);
}

function moneyFromLegacy(value: number, field: string): string {
  return canonicalMoney(value, field);
}

/** Never overwrite an existing exact value; reject disagreement with legacy facts. */
function exactMoney(
  existing: DecimalInput | null,
  legacy: number,
  field: string
): string {
  const derived = moneyFromLegacy(legacy, field);
  if (existing === null) return derived;
  const exact = canonicalMoney(existing, field);
  if (compareDecimal(exact, derived, moneyFormat) !== 0) {
    throw new UnsafeSourceError(
      "EXACT_VALUE_MISMATCH",
      `${field} exact value ${exact} disagrees with legacy value ${derived}`
    );
  }
  return exact;
}

function exactPercentage(existing: DecimalInput | null, legacy: number, field: string): string {
  const derived = canonicalPercentage(legacy, field);
  if (existing === null) return derived;
  const exact = canonicalPercentage(existing, field);
  if (compareDecimal(exact, derived, moneyFormat) !== 0) {
    throw new UnsafeSourceError(
      "EXACT_VALUE_MISMATCH",
      `${field} exact value ${exact} disagrees with legacy value ${derived}`
    );
  }
  return exact;
}

function requireUsd(currencyCode: string | null, field: string): typeof USD {
  if (currencyCode !== null && currencyCode !== USD) {
    throw new UnsafeSourceError("UNSUPPORTED_CURRENCY", `${field} is ${currencyCode}, not USD`);
  }
  return USD;
}

function assertApplicationCurrencies(
  paymentId: string,
  paymentCurrency: string | null,
  invoiceId: string,
  invoiceCurrency: string | null
): void {
  if (paymentCurrency !== null && invoiceCurrency !== null && paymentCurrency !== invoiceCurrency) {
    throw new UnsafeSourceError(
      "CROSS_CURRENCY_APPLICATION",
      `payment ${paymentId} and invoice ${invoiceId} have different currencies`
    );
  }
  requireUsd(paymentCurrency, `payment ${paymentId} currency`);
  requireUsd(invoiceCurrency, `invoice ${invoiceId} currency`);
}

function sumAmounts(
  values: readonly { amount: number; amountDecimal: DecimalInput | null }[],
  field: string
): string {
  return values.reduce(
    (total, value) => addDecimal(total, exactMoney(value.amountDecimal, value.amount, field), moneyFormat),
    zeroMoney
  );
}

function assertApplicationsFitPayment(
  payment: Pick<PaymentFinancialBackfillSource, "id" | "customerId" | "amount" | "amountDecimal" | "currencyCode" | "applications">
): void {
  const paymentAmount = exactMoney(payment.amountDecimal, payment.amount, `payment ${payment.id} amount`);
  const paymentCurrency = requireUsd(payment.currencyCode, `payment ${payment.id} currency`);
  let applicationTotal = zeroMoney;
  for (const application of payment.applications) {
    if (application.invoice.customerId !== payment.customerId) {
      throw new UnsafeSourceError(
        "CROSS_CUSTOMER_APPLICATION",
        `payment ${payment.id} and invoice ${application.invoice.id} have different customers`
      );
    }
    assertApplicationCurrencies(
      payment.id,
      paymentCurrency,
      application.invoice.id,
      application.invoice.currencyCode
    );
    const applicationAmount = exactMoney(
      application.amountDecimal,
      application.amount,
      `application ${application.id} amount`
    );
    assertApplicationFitsInvoice(application.id, applicationAmount, application.invoice);
    applicationTotal = addDecimal(applicationTotal, applicationAmount, moneyFormat);
  }
  if (compareDecimal(applicationTotal, paymentAmount, moneyFormat) > 0) {
    throw new UnsafeSourceError(
      "APPLICATION_EXCEEDS_PAYMENT",
      `payment ${payment.id} applications ${applicationTotal} exceed payment amount ${paymentAmount}`
    );
  }
}

function assertApplicationFitsInvoice(
  applicationId: string,
  amount: string,
  invoice: InvoiceFact
): void {
  const invoiceTotal = exactMoney(invoice.totalDecimal, invoice.total, `invoice ${invoice.id} total`);
  if (compareDecimal(amount, invoiceTotal, moneyFormat) > 0) {
    throw new UnsafeSourceError(
      "APPLICATION_EXCEEDS_INVOICE",
      `application ${applicationId} amount ${amount} exceeds invoice ${invoice.id} total ${invoiceTotal}`
    );
  }
  const applicationTotal = sumAmounts(invoice.applications, `invoice ${invoice.id} application amount`);
  const amountPaid = exactMoney(
    invoice.amountPaidDecimal,
    invoice.amountPaid,
    `invoice ${invoice.id} amount paid`
  );
  if (compareDecimal(applicationTotal, amountPaid, moneyFormat) !== 0) {
    throw new UnsafeSourceError(
      "UNRECONCILED_INVOICE_APPLICATIONS",
      `invoice ${invoice.id} applications ${applicationTotal} do not match amount paid ${amountPaid}`
    );
  }
  if (compareDecimal(applicationTotal, invoiceTotal, moneyFormat) > 0) {
    throw new UnsafeSourceError(
      "APPLICATIONS_EXCEED_INVOICE",
      `invoice ${invoice.id} applications ${applicationTotal} exceed total ${invoiceTotal}`
    );
  }
}

function transform<Write>(
  source: FinancialBackfillRow & SourceError,
  prepare: () => Write
): BackfillTransformResult<Write> {
  const failed = sourceFailure(source);
  if (failed !== undefined) return failed;
  try {
    const write = prepare();
    return { kind: "ready", afterAmount: source.beforeAmount, write };
  } catch (error) {
    if (error instanceof UnsafeSourceError) return unsafe(error.code, error.message);
    return unsafe(
      "UNREPRESENTABLE_LEGACY_DECIMAL",
      error instanceof Error ? error.message : "Legacy financial data is not representable"
    );
  }
}

export function prepareProductFinancialBackfill(
  source: ProductFinancialBackfillSource
): BackfillTransformResult<ProductFinancialBackfillWrite> {
  return transform(source, () => ({
    id: source.id,
    listPriceDecimal: exactMoney(source.listPriceDecimal, source.listPrice, `product ${source.id} list price`),
    currencyCode: requireUsd(source.currencyCode, `product ${source.id} currency`),
  }));
}

export function prepareRateFinancialBackfill(
  source: RateFinancialBackfillSource
): BackfillTransformResult<RateFinancialBackfillWrite> {
  return transform(source, () => {
    const currencyCode = requireUsd(source.currencyCode, `rate ${source.id} currency`);
    const productCurrency = requireUsd(source.productCurrencyCode, `rate ${source.id} product currency`);
    if (currencyCode !== productCurrency) {
      throw new UnsafeSourceError("RATE_PRODUCT_CURRENCY_MISMATCH", `rate ${source.id} currency mismatches product`);
    }
    let tiers: ReturnType<typeof serializeRateTiers>;
    try {
      const exactTiers = ExactRateTierSchema.array().safeParse(source.tiers);
      tiers = exactTiers.success
        ? exactTiers.data
        : serializeRateTiers(parseRateTiers(source.tiers));
    } catch (error) {
      throw new UnsafeSourceError(
        "MALFORMED_RATE_TIERS",
        error instanceof Error ? error.message : `rate ${source.id} tiers are malformed`
      );
    }
    return {
      id: source.id,
      unitPriceDecimal: exactMoney(source.unitPriceDecimal, source.unitPrice, `rate ${source.id} unit price`),
      currencyCode,
      tiers,
    };
  });
}

export function prepareDiscountFinancialBackfill(
  source: DiscountFinancialBackfillSource
): BackfillTransformResult<DiscountFinancialBackfillWrite> {
  return transform(source, () => ({
    id: source.id,
    percentOffDecimal: exactPercentage(
      source.percentOffDecimal,
      source.percentOff,
      `discount ${source.id} percent off`
    ),
  }));
}

export function preparePaymentFinancialBackfill(
  source: PaymentFinancialBackfillSource
): BackfillTransformResult<PaymentFinancialBackfillWrite> {
  return transform(source, () => {
    assertApplicationsFitPayment(source);
    return {
      id: source.id,
      amountDecimal: exactMoney(source.amountDecimal, source.amount, `payment ${source.id} amount`),
      currencyCode: requireUsd(source.currencyCode, `payment ${source.id} currency`),
    };
  });
}

export function preparePaymentApplicationFinancialBackfill(
  source: PaymentApplicationFinancialBackfillSource
): BackfillTransformResult<PaymentApplicationFinancialBackfillWrite> {
  return transform(source, () => {
    const amountDecimal = exactMoney(
      source.amountDecimal,
      source.amount,
      `application ${source.id} amount`
    );
    assertApplicationsFitPayment(source.payment);
    if (source.payment.customerId !== source.invoice.customerId) {
      throw new UnsafeSourceError(
        "CROSS_CUSTOMER_APPLICATION",
        `payment ${source.payment.id} and invoice ${source.invoice.id} have different customers`
      );
    }
    assertApplicationCurrencies(
      source.payment.id,
      source.payment.currencyCode,
      source.invoice.id,
      source.invoice.currencyCode
    );
    assertApplicationFitsInvoice(source.id, amountDecimal, source.invoice);
    return { id: source.id, amountDecimal };
  });
}

function safeSource<Row extends Omit<FinancialBackfillRow, "beforeAmount">>(
  row: Row,
  legacyAmount: number,
  field: string
): Row & FinancialBackfillRow & SourceError {
  try {
    return { ...row, beforeAmount: moneyFromLegacy(legacyAmount, field) };
  } catch (error) {
    return {
      ...row,
      beforeAmount: zeroMoney,
      sourceError: error instanceof Error ? error.message : "Legacy value is not representable",
    };
  }
}

function productRepository(): FinancialBackfillRepository<
  ProductFinancialBackfillSource,
  ProductFinancialBackfillWrite
> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const rows = await prisma.product.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
      });
      return rows.map((row) => safeSource(row, row.listPrice, `product ${row.id} list price`));
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              await transaction.product.update({ where: { id: write.id }, data: write });
            }
          },
          async saveCheckpoint(jobName, checkpoint) {
            await transaction.backfillCheckpoint.upsert({
              where: { jobName },
              create: { jobName, lastId: checkpoint },
              update: { lastId: checkpoint, completedAt: null },
            });
          },
        })
      );
    },
  };
}

function rateRepository(): FinancialBackfillRepository<RateFinancialBackfillSource, RateFinancialBackfillWrite> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const rows = await prisma.rate.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
        include: { product: true },
      });
      return rows.map((row) =>
        safeSource(
          {
            id: row.id,
            unitPrice: row.unitPrice,
            unitPriceDecimal: row.unitPriceDecimal,
            currencyCode: row.currencyCode,
            productCurrencyCode: row.product.currencyCode,
            tiers: row.tiers,
          },
          row.unitPrice,
          `rate ${row.id} unit price`
        )
      );
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              await transaction.rate.update({ where: { id: write.id }, data: write });
            }
          },
          async saveCheckpoint(jobName, checkpoint) {
            await transaction.backfillCheckpoint.upsert({
              where: { jobName },
              create: { jobName, lastId: checkpoint },
              update: { lastId: checkpoint, completedAt: null },
            });
          },
        })
      );
    },
  };
}

function discountRepository(): FinancialBackfillRepository<
  DiscountFinancialBackfillSource,
  DiscountFinancialBackfillWrite
> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const rows = await prisma.comboDiscount.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
      });
      return rows.map((row) => safeSource(row, row.percentOff, `discount ${row.id} percent off`));
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              await transaction.comboDiscount.update({ where: { id: write.id }, data: write });
            }
          },
          async saveCheckpoint(jobName, checkpoint) {
            await transaction.backfillCheckpoint.upsert({
              where: { jobName },
              create: { jobName, lastId: checkpoint },
              update: { lastId: checkpoint, completedAt: null },
            });
          },
        })
      );
    },
  };
}

function invoiceFact(invoice: {
  id: string;
  customerId: string;
  currencyCode: string | null;
  total: number;
  totalDecimal: DecimalInput | null;
  amountPaid: number;
  amountPaidDecimal: DecimalInput | null;
  applications: readonly { id: string; amount: number; amountDecimal: DecimalInput | null }[];
}): InvoiceFact {
  return invoice;
}

function paymentRepository(): FinancialBackfillRepository<
  PaymentFinancialBackfillSource,
  PaymentFinancialBackfillWrite
> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const rows = await prisma.payment.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
        include: { applications: { include: { invoice: { include: { applications: true } } } } },
      });
      return rows.map((row) =>
        safeSource(
          {
            id: row.id,
            customerId: row.customerId,
            amount: row.amount,
            amountDecimal: row.amountDecimal,
            currencyCode: row.currencyCode,
            applications: row.applications.map((application) => ({
              id: application.id,
              amount: application.amount,
              amountDecimal: application.amountDecimal,
              invoice: invoiceFact(application.invoice),
            })),
          },
          row.amount,
          `payment ${row.id} amount`
        )
      );
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              await transaction.payment.update({ where: { id: write.id }, data: write });
            }
          },
          async saveCheckpoint(jobName, checkpoint) {
            await transaction.backfillCheckpoint.upsert({
              where: { jobName },
              create: { jobName, lastId: checkpoint },
              update: { lastId: checkpoint, completedAt: null },
            });
          },
        })
      );
    },
  };
}

function paymentApplicationRepository(): FinancialBackfillRepository<
  PaymentApplicationFinancialBackfillSource,
  PaymentApplicationFinancialBackfillWrite
> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const rows = await prisma.paymentApplication.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
        include: {
          payment: { include: { applications: { include: { invoice: { include: { applications: true } } } } } },
          invoice: { include: { applications: true } },
        },
      });
      return rows.map((row) =>
        safeSource(
          {
            id: row.id,
            amount: row.amount,
            amountDecimal: row.amountDecimal,
            payment: {
              id: row.payment.id,
              customerId: row.payment.customerId,
              currencyCode: row.payment.currencyCode,
              amount: row.payment.amount,
              amountDecimal: row.payment.amountDecimal,
              applications: row.payment.applications.map((application) => ({
                id: application.id,
                amount: application.amount,
                amountDecimal: application.amountDecimal,
                invoice: invoiceFact(application.invoice),
              })),
            },
            invoice: invoiceFact(row.invoice),
          },
          row.amount,
          `application ${row.id} amount`
        )
      );
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              await transaction.paymentApplication.update({ where: { id: write.id }, data: write });
            }
          },
          async saveCheckpoint(jobName, checkpoint) {
            await transaction.backfillCheckpoint.upsert({
              where: { jobName },
              create: { jobName, lastId: checkpoint },
              update: { lastId: checkpoint, completedAt: null },
            });
          },
        })
      );
    },
  };
}

type Stage = {
  readonly name: string;
  readonly run: (options: {
    batchSize: number;
    dryRun: boolean;
    wait?: () => Promise<void>;
  }) => Promise<FinancialBackfillResult>;
};

function stage<Row extends FinancialBackfillRow, Write>(
  name: string,
  jobName: string,
  repository: FinancialBackfillRepository<Row, Write>,
  prepare: (source: Row) => BackfillTransformResult<Write>
): Stage {
  return {
    name,
    async run(options) {
      const result = await runFinancialBackfill(
        {
          jobName,
          batchSize: options.batchSize,
          dryRun: options.dryRun,
          maxMismatchedRows: 0,
          requireExactTotals: true,
        },
        {
          repository,
          transform: prepare,
          ...(options.wait === undefined ? {} : { wait: options.wait }),
        }
      );
      if (!result.dryRun && result.state === "COMPLETE") {
        await prisma.backfillCheckpoint.upsert({
          where: { jobName },
          create: { jobName, lastId: result.checkpoint, completedAt: new Date() },
          update: { completedAt: new Date() },
        });
      }
      return result;
    },
  };
}

const stages: readonly Stage[] = [
  stage("products", PRODUCT_FINANCIAL_BACKFILL_JOB, productRepository(), prepareProductFinancialBackfill),
  stage("rates", RATE_FINANCIAL_BACKFILL_JOB, rateRepository(), prepareRateFinancialBackfill),
  stage("discounts", DISCOUNT_FINANCIAL_BACKFILL_JOB, discountRepository(), prepareDiscountFinancialBackfill),
  stage("payments", PAYMENT_FINANCIAL_BACKFILL_JOB, paymentRepository(), preparePaymentFinancialBackfill),
  stage(
    "paymentApplications",
    PAYMENT_APPLICATION_FINANCIAL_BACKFILL_JOB,
    paymentApplicationRepository(),
    preparePaymentApplicationFinancialBackfill
  ),
];

/**
 * Safe legacy fields only. Order pricing snapshots are intentionally excluded:
 * their historical tiers/discounts/product terms are not reliably derivable.
 */
export async function runLegacyFinancialBackfill(options: {
  readonly batchSize?: number;
  /** Defaults to preview mode; operators must explicitly opt in to writes. */
  readonly dryRun?: boolean;
  /** Optional pause between batches so operators can control writer contention. */
  readonly wait?: () => Promise<void>;
} = {}): Promise<LegacyFinancialBackfillResult> {
  const dryRun = options.dryRun ?? true;
  const batchSize = options.batchSize ?? 100;
  const results: { name: string; result: FinancialBackfillResult }[] = [];
  for (const current of stages) {
    const result = await current.run({
      batchSize,
      dryRun,
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    });
    results.push({ name: current.name, result });
    if (result.state === "PARTIAL") {
      const output: LegacyFinancialBackfillResult = { state: "PARTIAL", dryRun, stages: results };
      LegacyFinancialBackfillResultSchema.parse(output);
      return output;
    }
  }
  const output: LegacyFinancialBackfillResult = { state: "COMPLETE", dryRun, stages: results };
  LegacyFinancialBackfillResultSchema.parse(output);
  return output;
}
