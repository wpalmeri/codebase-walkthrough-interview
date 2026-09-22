import {
  EmailAddressSchema,
  InvoiceStatusSchema,
  type InvoiceStatus,
} from "@meridian/contracts";
import { z } from "zod";
import { prisma } from "../db";
import {
  canonicalMoney,
  canonicalQuantity,
  type DecimalInput,
} from "../domain/money";
import {
  runFinancialBackfill,
  type BackfillTransformResult,
  type FinancialBackfillRepository,
  type FinancialBackfillResult,
  type FinancialBackfillRow,
} from "./financialBackfill";

export const INVOICE_SNAPSHOT_BACKFILL_JOB = "invoice-snapshot-v1";
const invoiceStatus = InvoiceStatusSchema.enum;
const finalizedStatuses = new Set<InvoiceStatus>([
  invoiceStatus.POSTED,
  invoiceStatus.SENT,
  invoiceStatus.PAID,
  invoiceStatus.VOID,
]);
const zeroMoney = canonicalMoney("0");

export const InvoiceSnapshotBackfillUnsafeCodeSchema = z.enum([
  "AMBIGUOUS_INVOICE_LINE_EVIDENCE",
  "CONFLICTING_INVOICE_SNAPSHOT",
  "INVALID_INVOICE_LINE_EVIDENCE",
  "INVALID_INVOICE_STATUS",
  "INVALID_RECIPIENT_EVIDENCE",
  "MISSING_FINALIZED_BILL_TO_EVIDENCE",
  "MISSING_INVOICE_LINE_EVIDENCE",
]);
export type InvoiceSnapshotBackfillUnsafeCode = z.infer<
  typeof InvoiceSnapshotBackfillUnsafeCodeSchema
>;

interface ExactLineEvidence {
  readonly quantityDecimal: DecimalInput | null;
  readonly unitPriceDecimal: DecimalInput | null;
  readonly amountDecimal: DecimalInput | null;
}

export interface InvoiceSnapshotBackfillSource extends FinancialBackfillRow {
  readonly status: string;
  readonly customerNameSnapshot: string | null;
  readonly customerEmailSnapshot: string | null;
  readonly billingAddressSnapshot: string | null;
  readonly customer: {
    readonly name: string;
    readonly email: string;
    readonly billingAddress: string | null;
  };
  readonly lines: readonly (ExactLineEvidence & {
    readonly id: string;
    readonly description: string;
    readonly productSkuSnapshot: string | null;
    readonly productUnitSnapshot: string | null;
  })[];
  readonly orderItems: readonly (ExactLineEvidence & {
    readonly id: string;
    readonly productSkuSnapshot: string | null;
    readonly productNameSnapshot: string | null;
    readonly productUnitSnapshot: string | null;
  })[];
}

export interface InvoiceSnapshotBackfillWrite {
  readonly invoiceId: string;
  readonly customerNameSnapshot: string;
  readonly customerEmailSnapshot: string;
  readonly billingAddressSnapshot: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly productSkuSnapshot: string;
    readonly productUnitSnapshot: string;
  }[];
}

class UnsafeInvoiceHistoryError extends Error {
  constructor(
    readonly code: InvoiceSnapshotBackfillUnsafeCode,
    message: string
  ) {
    super(message);
  }
}

function unsafe(
  code: InvoiceSnapshotBackfillUnsafeCode,
  detail: string
): BackfillTransformResult<InvoiceSnapshotBackfillWrite> {
  return { kind: "unsafe", code, detail };
}

function exactLineKey(evidence: ExactLineEvidence, field: string): string {
  if (
    evidence.quantityDecimal === null ||
    evidence.unitPriceDecimal === null ||
    evidence.amountDecimal === null
  ) {
    throw new UnsafeInvoiceHistoryError(
      "MISSING_INVOICE_LINE_EVIDENCE",
      `${field} is missing exact quantity, unit-price, or amount evidence`
    );
  }
  return [
    canonicalQuantity(evidence.quantityDecimal, `${field} quantity`),
    canonicalMoney(evidence.unitPriceDecimal, `${field} unit price`),
    canonicalMoney(evidence.amountDecimal, `${field} amount`),
  ].join(":");
}

function capturedLine(
  source: InvoiceSnapshotBackfillSource,
  line: InvoiceSnapshotBackfillSource["lines"][number],
  unusedItems: Set<string>
): InvoiceSnapshotBackfillWrite["lines"][number] {
  const lineKey = exactLineKey(line, `invoice line ${line.id}`);
  const candidates = source.orderItems.filter((item) => {
    if (!unusedItems.has(item.id)) return false;
    if (
      item.productSkuSnapshot === null ||
      item.productNameSnapshot === null ||
      item.productUnitSnapshot === null
    ) {
      return false;
    }
    if (line.description !== `${item.productNameSnapshot} @ ${item.productUnitSnapshot}`) return false;
    try {
      return exactLineKey(item, `order item ${item.id}`) === lineKey;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) {
    throw new UnsafeInvoiceHistoryError(
      "MISSING_INVOICE_LINE_EVIDENCE",
      `invoice line ${line.id} has no unique captured order-item evidence`
    );
  }
  if (candidates.length > 1) {
    throw new UnsafeInvoiceHistoryError(
      "AMBIGUOUS_INVOICE_LINE_EVIDENCE",
      `invoice line ${line.id} matches multiple captured order items`
    );
  }
  const candidate = candidates[0];
  if (
    candidate === undefined ||
    candidate.productSkuSnapshot === null ||
    candidate.productUnitSnapshot === null
  ) {
    throw new UnsafeInvoiceHistoryError(
      "MISSING_INVOICE_LINE_EVIDENCE",
      `invoice line ${line.id} has incomplete captured order-item evidence`
    );
  }
  if (
    (line.productSkuSnapshot !== null && line.productSkuSnapshot !== candidate.productSkuSnapshot) ||
    (line.productUnitSnapshot !== null && line.productUnitSnapshot !== candidate.productUnitSnapshot)
  ) {
    throw new UnsafeInvoiceHistoryError(
      "CONFLICTING_INVOICE_SNAPSHOT",
      `invoice line ${line.id} conflicts with its captured order-item evidence`
    );
  }
  unusedItems.delete(candidate.id);
  return {
    id: line.id,
    productSkuSnapshot: candidate.productSkuSnapshot,
    productUnitSnapshot: candidate.productUnitSnapshot,
  };
}

export function prepareInvoiceSnapshotBackfill(
  source: InvoiceSnapshotBackfillSource
): BackfillTransformResult<InvoiceSnapshotBackfillWrite> {
  try {
    const parsedStatus = InvoiceStatusSchema.safeParse(source.status);
    if (!parsedStatus.success) {
      return unsafe("INVALID_INVOICE_STATUS", `invoice ${source.id} has an invalid status`);
    }
    const finalized = finalizedStatuses.has(parsedStatus.data);
    if (
      finalized &&
      (source.customerNameSnapshot === null || source.customerEmailSnapshot === null)
    ) {
      return unsafe(
        "MISSING_FINALIZED_BILL_TO_EVIDENCE",
        `finalized invoice ${source.id} has no immutable bill-to identity; manual reconciliation is required`
      );
    }
    const customerNameSnapshot = source.customerNameSnapshot ?? source.customer.name;
    const parsedEmail = EmailAddressSchema.safeParse(
      source.customerEmailSnapshot ?? source.customer.email
    );
    if (!parsedEmail.success) {
      return unsafe(
        "INVALID_RECIPIENT_EVIDENCE",
        `invoice ${source.id} does not have a valid snapshotted recipient`
      );
    }
    if (source.lines.length !== source.orderItems.length) {
      return unsafe(
        "MISSING_INVOICE_LINE_EVIDENCE",
        `invoice ${source.id} line count does not match its captured order items`
      );
    }
    const unusedItems = new Set(source.orderItems.map((item) => item.id));
    const lines = source.lines.map((line) => capturedLine(source, line, unusedItems));
    if (unusedItems.size > 0) {
      return unsafe(
        "MISSING_INVOICE_LINE_EVIDENCE",
        `invoice ${source.id} does not have one-to-one captured order-item evidence`
      );
    }
    return {
      kind: "ready",
      afterAmount: source.beforeAmount,
      write: {
        invoiceId: source.id,
        customerNameSnapshot,
        customerEmailSnapshot: parsedEmail.data,
        billingAddressSnapshot:
          source.billingAddressSnapshot ?? (finalized ? null : source.customer.billingAddress),
        lines,
      },
    };
  } catch (error) {
    if (error instanceof UnsafeInvoiceHistoryError) return unsafe(error.code, error.message);
    return unsafe(
      "INVALID_INVOICE_LINE_EVIDENCE",
      error instanceof Error ? error.message : `invoice ${source.id} evidence is invalid`
    );
  }
}

function invoiceSnapshotRepository(): FinancialBackfillRepository<
  InvoiceSnapshotBackfillSource,
  InvoiceSnapshotBackfillWrite
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
        include: { customer: true, lines: true, order: { include: { items: true } } },
      });
      return invoices.map((invoice) => ({
        id: invoice.id,
        beforeAmount: zeroMoney,
        status: invoice.status,
        customerNameSnapshot: invoice.customerNameSnapshot,
        customerEmailSnapshot: invoice.customerEmailSnapshot,
        billingAddressSnapshot: invoice.billingAddressSnapshot,
        customer: invoice.customer,
        lines: invoice.lines,
        orderItems: invoice.order.items.map((item) => ({
          id: item.id,
          productSkuSnapshot: item.productSkuSnapshot,
          productNameSnapshot: item.productNameSnapshot,
          productUnitSnapshot: item.productUnitSnapshot,
          quantityDecimal: item.quantityDecimal,
          unitPriceDecimal: item.effectiveUnitPriceDecimal,
          amountDecimal: item.amountDecimal,
        })),
      }));
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
                    productSkuSnapshot: line.productSkuSnapshot,
                    productUnitSnapshot: line.productUnitSnapshot,
                  },
                });
              }
              await transaction.invoice.update({
                where: { id: write.invoiceId },
                data: {
                  customerNameSnapshot: write.customerNameSnapshot,
                  customerEmailSnapshot: write.customerEmailSnapshot,
                  billingAddressSnapshot: write.billingAddressSnapshot,
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

export async function runInvoiceSnapshotBackfill(options: {
  readonly batchSize?: number;
  readonly dryRun?: boolean;
  readonly wait?: () => Promise<void>;
} = {}): Promise<FinancialBackfillResult> {
  const result = await runFinancialBackfill(
    {
      jobName: INVOICE_SNAPSHOT_BACKFILL_JOB,
      batchSize: options.batchSize ?? 100,
      dryRun: options.dryRun ?? true,
      maxMismatchedRows: 0,
      requireExactTotals: true,
    },
    {
      repository: invoiceSnapshotRepository(),
      transform: prepareInvoiceSnapshotBackfill,
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    }
  );
  if (!result.dryRun && result.state === "COMPLETE") {
    await prisma.backfillCheckpoint.upsert({
      where: { jobName: INVOICE_SNAPSHOT_BACKFILL_JOB },
      create: {
        jobName: INVOICE_SNAPSHOT_BACKFILL_JOB,
        lastId: result.checkpoint,
        completedAt: new Date(),
      },
      update: { completedAt: new Date() },
    });
  }
  return result;
}
