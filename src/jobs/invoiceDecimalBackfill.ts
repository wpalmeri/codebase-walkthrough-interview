import type { DecimalInput } from "../domain/money";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  addDecimal,
  canonicalMoney,
  compareDecimal,
  decimalOrLegacy,
} from "../domain/money";
import {
  parseAccountingDate,
  utcAccountingDateFromInstant,
} from "../domain/accountingPeriod";
import { prisma } from "../db";
import {
  runFinancialBackfill,
  type BackfillTransformResult,
  type FinancialBackfillRepository,
  type FinancialBackfillResult,
  type FinancialBackfillRow,
} from "./financialBackfill";

export const INVOICE_DECIMAL_BACKFILL_JOB = "invoice-decimal-v1";
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const quantityFormat = {
  scale: QUANTITY_SCALE,
  precision: QUANTITY_PRECISION,
  field: "quantity",
} as const;
const zeroMoney = canonicalMoney("0");

interface LegacyAmount {
  amount: number;
  amountDecimal: DecimalInput | null;
}

export interface InvoiceDecimalBackfillSource extends FinancialBackfillRow {
  issueDate: Date;
  accountingDate: string | null;
  total: number;
  totalDecimal: DecimalInput | null;
  amountPaid: number;
  amountPaidDecimal: DecimalInput | null;
  lines: {
    id: string;
    quantity: number;
    quantityDecimal: DecimalInput | null;
    unitPrice: number;
    unitPriceDecimal: DecimalInput | null;
    amount: number;
    amountDecimal: DecimalInput | null;
  }[];
  applications: LegacyAmount[];
  sourceError?: string;
}

export interface InvoiceDecimalBackfillWrite {
  readonly invoiceId: string;
  readonly accountingDate: string;
  readonly totalDecimal: string;
  readonly amountPaidDecimal: string;
  readonly lines: readonly {
    id: string;
    quantityDecimal: string;
    unitPriceDecimal: string;
    amountDecimal: string;
  }[];
}

function exactValue(
  decimal: DecimalInput | null,
  legacy: number,
  field: string
): string {
  return decimalOrLegacy(
    { decimal, legacy },
    { ...moneyFormat, field }
  );
}

export function prepareInvoiceDecimalBackfill(
  source: InvoiceDecimalBackfillSource
): BackfillTransformResult<InvoiceDecimalBackfillWrite> {
  if (source.sourceError !== undefined) {
    return {
      kind: "unsafe",
      code: "UNREPRESENTABLE_LEGACY_DECIMAL",
      detail: source.sourceError,
    };
  }
  try {
    const totalDecimal = decimalOrLegacy(
      { decimal: source.totalDecimal, legacy: source.total },
      { ...moneyFormat, field: `invoice ${source.id} total` }
    );
    const amountPaidDecimal = decimalOrLegacy(
      { decimal: source.amountPaidDecimal, legacy: source.amountPaid },
      { ...moneyFormat, field: `invoice ${source.id} amount paid` }
    );
    const lines = source.lines.map((line) => ({
      id: line.id,
      quantityDecimal: decimalOrLegacy(
        { decimal: line.quantityDecimal, legacy: line.quantity },
        { ...quantityFormat, field: `invoice line ${line.id} quantity` }
      ),
      unitPriceDecimal: exactValue(
        line.unitPriceDecimal,
        line.unitPrice,
        `invoice line ${line.id} unit price`
      ),
      amountDecimal: exactValue(
        line.amountDecimal,
        line.amount,
        `invoice line ${line.id} amount`
      ),
    }));
    const lineTotal = lines.reduce(
      (sum, line) => addDecimal(sum, line.amountDecimal, moneyFormat),
      zeroMoney
    );
    if (compareDecimal(lineTotal, totalDecimal, moneyFormat) !== 0) {
      return {
        kind: "unsafe",
        code: "UNMODELED_INVOICE_ADJUSTMENT",
        detail: `Invoice ${source.id} line total ${lineTotal} does not explain total ${totalDecimal}`,
      };
    }
    const applicationTotal = source.applications.reduce(
      (sum, application) =>
        addDecimal(
          sum,
          exactValue(
            application.amountDecimal,
            application.amount,
            "payment application amount"
          ),
          moneyFormat
        ),
      zeroMoney
    );
    if (compareDecimal(applicationTotal, amountPaidDecimal, moneyFormat) !== 0) {
      return {
        kind: "unsafe",
        code: "UNRECONCILED_PAYMENT_APPLICATIONS",
        detail: `Invoice ${source.id} applications ${applicationTotal} do not explain amount paid ${amountPaidDecimal}`,
      };
    }
    const accountingDate =
      source.accountingDate === null
        ? utcAccountingDateFromInstant(source.issueDate)
        : parseAccountingDate(source.accountingDate);
    return {
      kind: "ready",
      afterAmount: totalDecimal,
      write: {
        invoiceId: source.id,
        accountingDate,
        totalDecimal,
        amountPaidDecimal,
        lines,
      },
    };
  } catch (error) {
    return {
      kind: "unsafe",
      code: "UNREPRESENTABLE_LEGACY_DECIMAL",
      detail: error instanceof Error ? error.message : "Legacy invoice values are not representable",
    };
  }
}

function invoiceRepository(): FinancialBackfillRepository<
  InvoiceDecimalBackfillSource,
  InvoiceDecimalBackfillWrite
> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const invoices = await prisma.invoice.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
        include: { lines: true, applications: true },
      });
      return invoices.map((invoice) => {
        try {
          return {
            ...invoice,
            beforeAmount: decimalOrLegacy(
              { decimal: invoice.totalDecimal, legacy: invoice.total },
              { ...moneyFormat, field: `invoice ${invoice.id} total` }
            ),
          };
        } catch (error) {
          return {
            ...invoice,
            beforeAmount: zeroMoney,
            sourceError: error instanceof Error ? error.message : "Invalid invoice total",
          };
        }
      });
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              for (const line of write.lines) {
                await transaction.invoiceLine.update({
                  where: { id: line.id },
                  data: {
                    quantityDecimal: line.quantityDecimal,
                    unitPriceDecimal: line.unitPriceDecimal,
                    amountDecimal: line.amountDecimal,
                  },
                });
              }
              await transaction.invoice.update({
                where: { id: write.invoiceId },
                data: {
                  accountingDate: write.accountingDate,
                  totalDecimal: write.totalDecimal,
                  amountPaidDecimal: write.amountPaidDecimal,
                },
              });
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

export async function runInvoiceDecimalBackfill(options: {
  readonly batchSize?: number;
  readonly dryRun?: boolean;
  readonly wait?: () => Promise<void>;
} = {}): Promise<FinancialBackfillResult> {
  const result = await runFinancialBackfill(
    {
      jobName: INVOICE_DECIMAL_BACKFILL_JOB,
      batchSize: options.batchSize ?? 100,
      dryRun: options.dryRun ?? false,
      maxMismatchedRows: 0,
      requireExactTotals: true,
    },
    {
      repository: invoiceRepository(),
      transform: prepareInvoiceDecimalBackfill,
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    }
  );
  if (!result.dryRun && result.state === "COMPLETE") {
    await prisma.backfillCheckpoint.upsert({
      where: { jobName: INVOICE_DECIMAL_BACKFILL_JOB },
      create: {
        jobName: INVOICE_DECIMAL_BACKFILL_JOB,
        lastId: result.checkpoint,
        completedAt: new Date(),
      },
      update: { completedAt: new Date() },
    });
  }
  return result;
}
