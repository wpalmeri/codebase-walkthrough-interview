import { z } from "zod";
import { prisma } from "../db";
import { canonicalMoney, canonicalQuantity, type DecimalInput } from "../domain/money";
import {
  OrderPricingSnapshotSchema,
  repriceOrderPricingSnapshot,
  type CapturedOrderPricing,
} from "../domain/orderPricing";
import {
  runFinancialBackfill,
  type BackfillTransformResult,
  type FinancialBackfillRepository,
  type FinancialBackfillResult,
  type FinancialBackfillRow,
} from "./financialBackfill";

export const ORDER_PRICING_SNAPSHOT_BACKFILL_JOB = "order-pricing-snapshot-v1";
const USD = "USD";
const zeroMoney = canonicalMoney("0");

export const OrderPricingSnapshotBackfillUnsafeCodeSchema = z.enum([
  "CONFLICTING_PERSISTED_EVIDENCE",
  "CONFLICTING_PRICING_EVIDENCE",
  "CONFLICTING_SNAPSHOT_CURRENCY",
  "INVALID_PRICING_EVIDENCE",
  "MISSING_PRICING_EVIDENCE",
  "UNSUPPORTED_SNAPSHOT_CURRENCY",
]);
export type OrderPricingSnapshotBackfillUnsafeCode = z.infer<
  typeof OrderPricingSnapshotBackfillUnsafeCodeSchema
>;

export interface OrderPricingSnapshotBackfillItem {
  readonly id: string;
  readonly productSkuSnapshot: string | null;
  readonly productNameSnapshot: string | null;
  readonly productUnitSnapshot: string | null;
  readonly quantityDecimal: DecimalInput | null;
  readonly baseUnitPriceDecimal: DecimalInput | null;
  readonly effectiveUnitPriceDecimal: DecimalInput | null;
  readonly amountDecimal: DecimalInput | null;
  readonly pricingSnapshot: unknown;
  readonly pricingCapturedAt: Date | null;
  readonly snapshotVersion: number | null;
}

export interface OrderPricingSnapshotBackfillSource extends FinancialBackfillRow {
  readonly currencyCode: string | null;
  readonly items: readonly OrderPricingSnapshotBackfillItem[];
}

export interface OrderPricingSnapshotBackfillWrite {
  readonly orderId: string;
  readonly currencyCode: typeof USD;
  readonly items: readonly {
    readonly id: string;
    readonly productSkuSnapshot: string;
    readonly productNameSnapshot: string;
    readonly productUnitSnapshot: string;
    readonly quantityDecimal: string;
    readonly baseUnitPriceDecimal: string;
    readonly effectiveUnitPriceDecimal: string;
    readonly amountDecimal: string;
    readonly pricingCapturedAt: Date;
    readonly snapshotVersion: number;
  }[];
}

class UnsafeHistoryError extends Error {
  constructor(
    readonly code: OrderPricingSnapshotBackfillUnsafeCode,
    message: string
  ) {
    super(message);
  }
}

function unsafe(
  code: OrderPricingSnapshotBackfillUnsafeCode,
  detail: string
): BackfillTransformResult<OrderPricingSnapshotBackfillWrite> {
  return { kind: "unsafe", code, detail };
}

function requireEqual(field: string, actual: string | number | null, expected: string | number): void {
  if (actual !== null && actual !== expected) {
    throw new UnsafeHistoryError(
      "CONFLICTING_PERSISTED_EVIDENCE",
      `${field} disagrees with the captured pricing snapshot`
    );
  }
}

function requireExactMoney(field: string, actual: DecimalInput | null, expected: string): void {
  if (actual === null) return;
  if (canonicalMoney(actual, field) !== expected) {
    throw new UnsafeHistoryError(
      "CONFLICTING_PERSISTED_EVIDENCE",
      `${field} disagrees with the captured pricing snapshot`
    );
  }
}

function requireExactQuantity(field: string, actual: DecimalInput | null, expected: string): void {
  if (actual === null) return;
  if (canonicalQuantity(actual, field) !== expected) {
    throw new UnsafeHistoryError(
      "CONFLICTING_PERSISTED_EVIDENCE",
      `${field} disagrees with the captured pricing snapshot`
    );
  }
}

function rehydrateItem(item: OrderPricingSnapshotBackfillItem): CapturedOrderPricing {
  if (item.pricingSnapshot === null) {
    throw new UnsafeHistoryError(
      "MISSING_PRICING_EVIDENCE",
      `order item ${item.id} has no persisted pricing snapshot`
    );
  }
  let snapshot: z.infer<typeof OrderPricingSnapshotSchema>;
  let captured: CapturedOrderPricing;
  try {
    snapshot = OrderPricingSnapshotSchema.parse(item.pricingSnapshot);
    captured = repriceOrderPricingSnapshot(snapshot, snapshot.quantity);
  } catch (error) {
    throw new UnsafeHistoryError(
      "INVALID_PRICING_EVIDENCE",
      error instanceof Error ? `order item ${item.id}: ${error.message}` : `order item ${item.id} is invalid`
    );
  }

  // Repricing is performed solely from the snapshot terms above. These checks
  // prove that the persisted snapshot's own totals and discounts are coherent.
  if (
    captured.pricingSnapshot.subtotal !== snapshot.subtotal ||
    captured.pricingSnapshot.total !== snapshot.total ||
    JSON.stringify(captured.pricingSnapshot.discounts) !== JSON.stringify(snapshot.discounts)
  ) {
    throw new UnsafeHistoryError(
      "CONFLICTING_PRICING_EVIDENCE",
      `order item ${item.id} pricing snapshot does not reproduce its stored totals`
    );
  }

  requireEqual(`order item ${item.id} SKU`, item.productSkuSnapshot, captured.productSkuSnapshot);
  requireEqual(`order item ${item.id} name`, item.productNameSnapshot, captured.productNameSnapshot);
  requireEqual(`order item ${item.id} unit`, item.productUnitSnapshot, captured.productUnitSnapshot);
  requireExactQuantity(`order item ${item.id} quantity`, item.quantityDecimal, captured.quantityDecimal);
  requireExactMoney(`order item ${item.id} base price`, item.baseUnitPriceDecimal, captured.baseUnitPriceDecimal);
  requireExactMoney(
    `order item ${item.id} effective price`,
    item.effectiveUnitPriceDecimal,
    captured.effectiveUnitPriceDecimal
  );
  requireExactMoney(`order item ${item.id} amount`, item.amountDecimal, captured.amountDecimal);
  if (
    item.pricingCapturedAt !== null &&
    item.pricingCapturedAt.toISOString() !== new Date(captured.pricingCapturedAt).toISOString()
  ) {
    throw new UnsafeHistoryError(
      "CONFLICTING_PERSISTED_EVIDENCE",
      `order item ${item.id} capture timestamp disagrees with the pricing snapshot`
    );
  }
  requireEqual(`order item ${item.id} snapshot version`, item.snapshotVersion, captured.snapshotVersion);
  return captured;
}

/**
 * Rehydrates only fields provable from persisted snapshot JSON. It never reads
 * a Product, Rate, or ComboDiscount row, because current catalog state cannot
 * establish historical commercial terms.
 */
export function prepareOrderPricingSnapshotBackfill(
  source: OrderPricingSnapshotBackfillSource
): BackfillTransformResult<OrderPricingSnapshotBackfillWrite> {
  try {
    if (source.items.length === 0) {
      return unsafe("MISSING_PRICING_EVIDENCE", `order ${source.id} has no order-item snapshots`);
    }
    const capturedItems = source.items.map(rehydrateItem);
    const currencies = new Set(capturedItems.map((item) => item.currencyCode));
    if (currencies.size !== 1) {
      return unsafe(
        "CONFLICTING_SNAPSHOT_CURRENCY",
        `order ${source.id} has conflicting captured item currencies`
      );
    }
    const [currencyCode] = currencies;
    if (currencyCode === undefined) {
      return unsafe("MISSING_PRICING_EVIDENCE", `order ${source.id} has no captured currency`);
    }
    if (currencyCode !== USD) {
      return unsafe("UNSUPPORTED_SNAPSHOT_CURRENCY", `order ${source.id} captured currency is unsupported`);
    }
    if (source.currencyCode !== null && source.currencyCode !== currencyCode) {
      return unsafe(
        "CONFLICTING_PERSISTED_EVIDENCE",
        `order ${source.id} currency disagrees with captured item currencies`
      );
    }
    return {
      kind: "ready",
      // Snapshot reconstruction does not alter a historical monetary fact; all
      // numeric values are rehydrated from the snapshot itself. The engine's
      // aggregate reconciliation therefore intentionally uses a zero delta.
      afterAmount: source.beforeAmount,
      write: {
        orderId: source.id,
        currencyCode,
        items: capturedItems.map((item, index) => ({
          id: source.items[index]?.id ?? item.productId,
          productSkuSnapshot: item.productSkuSnapshot,
          productNameSnapshot: item.productNameSnapshot,
          productUnitSnapshot: item.productUnitSnapshot,
          quantityDecimal: item.quantityDecimal,
          baseUnitPriceDecimal: item.baseUnitPriceDecimal,
          effectiveUnitPriceDecimal: item.effectiveUnitPriceDecimal,
          amountDecimal: item.amountDecimal,
          pricingCapturedAt: new Date(item.pricingCapturedAt),
          snapshotVersion: item.snapshotVersion,
        })),
      },
    };
  } catch (error) {
    if (error instanceof UnsafeHistoryError) return unsafe(error.code, error.message);
    return unsafe(
      "INVALID_PRICING_EVIDENCE",
      error instanceof Error ? error.message : `order ${source.id} pricing evidence is invalid`
    );
  }
}

function orderRepository(): FinancialBackfillRepository<
  OrderPricingSnapshotBackfillSource,
  OrderPricingSnapshotBackfillWrite
> {
  return {
    async loadCheckpoint(jobName) {
      return (await prisma.backfillCheckpoint.findUnique({ where: { jobName } }))?.lastId ?? null;
    },
    async fetchAfter(afterId, limit) {
      const orders = await prisma.order.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: limit,
        // Intentionally no product/rate/discount includes: only the persisted
        // snapshot JSON is allowed to establish historical terms.
        include: { items: true },
      });
      return orders.map((order) => ({
        id: order.id,
        beforeAmount: zeroMoney,
        currencyCode: order.currencyCode,
        items: order.items,
      }));
    },
    transaction(operation) {
      return prisma.$transaction((transaction) =>
        operation({
          async writeRows(writes) {
            for (const write of writes) {
              // Currency must be set before item capture: the ledger guard
              // deliberately freezes order identity once any item is captured.
              await transaction.order.update({
                where: { id: write.orderId },
                data: { currencyCode: write.currencyCode },
              });
              for (const item of write.items) {
                await transaction.orderItem.update({
                  where: { id: item.id },
                  data: {
                    productSkuSnapshot: item.productSkuSnapshot,
                    productNameSnapshot: item.productNameSnapshot,
                    productUnitSnapshot: item.productUnitSnapshot,
                    quantityDecimal: item.quantityDecimal,
                    baseUnitPriceDecimal: item.baseUnitPriceDecimal,
                    effectiveUnitPriceDecimal: item.effectiveUnitPriceDecimal,
                    amountDecimal: item.amountDecimal,
                    pricingCapturedAt: item.pricingCapturedAt,
                    snapshotVersion: item.snapshotVersion,
                  },
                });
              }
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

export async function runOrderPricingSnapshotBackfill(options: {
  readonly batchSize?: number;
  /** Defaults to preview mode; operators must explicitly opt in to writes. */
  readonly dryRun?: boolean;
  /** Injected throttle for bounded production batches and deterministic tests. */
  readonly wait?: () => Promise<void>;
} = {}): Promise<FinancialBackfillResult> {
  const result = await runFinancialBackfill(
    {
      jobName: ORDER_PRICING_SNAPSHOT_BACKFILL_JOB,
      batchSize: options.batchSize ?? 100,
      dryRun: options.dryRun ?? true,
      maxMismatchedRows: 0,
      requireExactTotals: true,
    },
    {
      repository: orderRepository(),
      transform: prepareOrderPricingSnapshotBackfill,
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    }
  );
  if (!result.dryRun && result.state === "COMPLETE") {
    await prisma.backfillCheckpoint.upsert({
      where: { jobName: ORDER_PRICING_SNAPSHOT_BACKFILL_JOB },
      create: {
        jobName: ORDER_PRICING_SNAPSHOT_BACKFILL_JOB,
        lastId: result.checkpoint,
        completedAt: new Date(),
      },
      update: { completedAt: new Date() },
    });
  }
  return result;
}
