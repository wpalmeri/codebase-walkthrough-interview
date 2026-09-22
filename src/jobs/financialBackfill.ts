import { MoneyStringSchema, type MoneyString } from "@meridian/contracts";
import { z } from "zod";
import { MONEY_PRECISION, MONEY_SCALE, addDecimal, compareDecimal } from "../domain/money";

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "backfill amount" } as const;
const zeroMoney: MoneyString = "0.0000";

/** A repository row intentionally contains only known historical facts. */
export const FinancialBackfillRowSchema = z.strictObject({
  id: z.string().min(1),
  beforeAmount: MoneyStringSchema,
});
export type FinancialBackfillRow = z.infer<typeof FinancialBackfillRowSchema>;

export const BackfillReadyResultSchema = z.strictObject({
  kind: z.literal("ready"),
  afterAmount: MoneyStringSchema,
  write: z.unknown(),
});
export const BackfillUnsafeResultSchema = z.strictObject({
  kind: z.literal("unsafe"),
  code: z.string().min(1),
  detail: z.string().min(1),
});
export const BackfillTransformResultSchema = z.discriminatedUnion("kind", [
  BackfillReadyResultSchema,
  BackfillUnsafeResultSchema,
]);
export type BackfillTransformResult<Write> =
  | (z.infer<typeof BackfillReadyResultSchema> & { readonly write: Write })
  | z.infer<typeof BackfillUnsafeResultSchema>;

export const FinancialBackfillOptionsSchema = z.strictObject({
  jobName: z.string().min(1),
  batchSize: z.number().int().min(1).max(10_000).default(100),
  dryRun: z.boolean().default(false),
  /** Stop after this many rows produce a different exact monetary result. */
  maxMismatchedRows: z.number().int().min(0).default(0),
  /** Stop if aggregate exact before/after totals differ, even within row allowance. */
  requireExactTotals: z.boolean().default(true),
});
export type FinancialBackfillOptions = z.input<typeof FinancialBackfillOptionsSchema>;

export const FinancialBackfillResultSchema = z.strictObject({
  state: z.enum(["COMPLETE", "PARTIAL"]),
  dryRun: z.boolean(),
  checkpoint: z.string().nullable(),
  batches: z.number().int().nonnegative(),
  rowsRead: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
  mismatchedRows: z.number().int().nonnegative(),
  beforeTotal: MoneyStringSchema,
  afterTotal: MoneyStringSchema,
  stop: z
    .strictObject({
      code: z.string().min(1),
      detail: z.string().min(1),
      rowId: z.string().min(1).optional(),
    })
    .optional(),
});
export type FinancialBackfillResult = z.infer<typeof FinancialBackfillResultSchema>;

export interface FinancialBackfillTransaction<Write> {
  /** Implement as idempotent upserts keyed by source primary key. */
  writeRows(writes: readonly Write[]): Promise<void>;
  saveCheckpoint(jobName: string, checkpoint: string): Promise<void>;
}

export interface FinancialBackfillRepository<Write> {
  loadCheckpoint(jobName: string): Promise<string | null>;
  /** Must return at most limit rows, strictly ordered by id and after afterId. */
  fetchAfter(afterId: string | null, limit: number): Promise<readonly FinancialBackfillRow[]>;
  transaction<T>(operation: (transaction: FinancialBackfillTransaction<Write>) => Promise<T>): Promise<T>;
}

export interface FinancialBackfillDependencies<Write> {
  readonly repository: FinancialBackfillRepository<Write>;
  readonly transform: (row: FinancialBackfillRow) => BackfillTransformResult<Write>;
  /** Injected so production can throttle without making tests sleep. */
  readonly wait?: () => Promise<void>;
}

interface MutableRun {
  checkpoint: string | null;
  batches: number;
  rowsRead: number;
  rowsWritten: number;
  mismatchedRows: number;
  beforeTotal: MoneyString;
  afterTotal: MoneyString;
}

function addMoney(left: MoneyString, right: MoneyString): MoneyString {
  return addDecimal(left, right, moneyFormat);
}

function result(run: MutableRun, dryRun: boolean, stop?: FinancialBackfillResult["stop"]): FinancialBackfillResult {
  return FinancialBackfillResultSchema.parse({
    state: stop === undefined ? "COMPLETE" : "PARTIAL",
    dryRun,
    checkpoint: run.checkpoint,
    batches: run.batches,
    rowsRead: run.rowsRead,
    rowsWritten: run.rowsWritten,
    mismatchedRows: run.mismatchedRows,
    beforeTotal: run.beforeTotal,
    afterTotal: run.afterTotal,
    ...(stop === undefined ? {} : { stop }),
  });
}

function invalidBatch(rows: readonly FinancialBackfillRow[], checkpoint: string | null): FinancialBackfillResult["stop"] | undefined {
  let previousId = checkpoint;
  for (const row of rows) {
    const parsed = FinancialBackfillRowSchema.safeParse(row);
    if (!parsed.success) {
      return { code: "INVALID_SOURCE_ROW", detail: "Repository returned an invalid backfill row" };
    }
    if (previousId !== null && row.id <= previousId) {
      return {
        code: "UNSTABLE_PRIMARY_KEY_ORDER",
        detail: "Repository must return rows strictly ordered after the checkpoint",
        rowId: row.id,
      };
    }
    previousId = row.id;
  }
  return undefined;
}

/**
 * Runs bounded, primary-key ordered transformation batches. Checkpoints are
 * written in the same transaction as writes, so a failed batch is retried from
 * its prior checkpoint and cannot skip rows.
 */
export async function runFinancialBackfill<Write>(
  rawOptions: FinancialBackfillOptions,
  dependencies: FinancialBackfillDependencies<Write>
): Promise<FinancialBackfillResult> {
  const options = FinancialBackfillOptionsSchema.parse(rawOptions);
  const run: MutableRun = {
    checkpoint: await dependencies.repository.loadCheckpoint(options.jobName),
    batches: 0,
    rowsRead: 0,
    rowsWritten: 0,
    mismatchedRows: 0,
    beforeTotal: zeroMoney,
    afterTotal: zeroMoney,
  };
  let cursor = run.checkpoint;

  for (;;) {
    const rows = await dependencies.repository.fetchAfter(cursor, options.batchSize);
    const orderingStop = invalidBatch(rows, cursor);
    if (orderingStop) return result(run, options.dryRun, orderingStop);
    if (rows.length === 0) return result(run, options.dryRun);

    const writes: Write[] = [];
    let batchBefore = zeroMoney;
    let batchAfter = zeroMoney;
    let batchMismatches = 0;
    for (const row of rows) {
      const transformed = dependencies.transform(row);
      if (transformed.kind === "unsafe") {
        const unsafe = BackfillUnsafeResultSchema.safeParse(transformed);
        if (!unsafe.success) {
          return result(run, options.dryRun, {
            code: "TRANSFORM_CONTRACT_VIOLATION",
            detail: "Transformer returned an invalid unsafe result",
            rowId: row.id,
          });
        }
        return result(run, options.dryRun, {
          code: unsafe.data.code,
          detail: unsafe.data.detail,
          rowId: row.id,
        });
      }
      const ready = BackfillReadyResultSchema.safeParse(transformed);
      if (!ready.success) {
        return result(run, options.dryRun, {
          code: "TRANSFORM_CONTRACT_VIOLATION",
          detail: "Transformer returned an invalid ready result",
          rowId: row.id,
        });
      }
      batchBefore = addMoney(batchBefore, row.beforeAmount);
      batchAfter = addMoney(batchAfter, ready.data.afterAmount);
      if (compareDecimal(row.beforeAmount, ready.data.afterAmount, moneyFormat) !== 0) {
        batchMismatches += 1;
      }
      if (run.mismatchedRows + batchMismatches > options.maxMismatchedRows) {
        return result(run, options.dryRun, {
          code: "MISMATCH_THRESHOLD_EXCEEDED",
          detail: "Backfill row mismatch threshold was exceeded",
          rowId: row.id,
        });
      }
      writes.push(transformed.write);
    }

    const beforeAfterMismatch = compareDecimal(
      addMoney(run.beforeTotal, batchBefore),
      addMoney(run.afterTotal, batchAfter),
      moneyFormat
    ) !== 0;
    if (options.requireExactTotals && beforeAfterMismatch) {
      return result(run, options.dryRun, {
        code: "TOTAL_RECONCILIATION_FAILED",
        detail: "Exact before and after totals do not reconcile",
      });
    }

    const nextCheckpoint = rows.at(-1)?.id;
    if (nextCheckpoint === undefined) throw new Error("non-empty batch has no checkpoint");
    if (!options.dryRun) {
      await dependencies.repository.transaction(async (transaction) => {
        await transaction.writeRows(writes);
        await transaction.saveCheckpoint(options.jobName, nextCheckpoint);
      });
      run.rowsWritten += writes.length;
      run.checkpoint = nextCheckpoint;
    }
    run.batches += 1;
    run.rowsRead += rows.length;
    run.mismatchedRows += batchMismatches;
    run.beforeTotal = addMoney(run.beforeTotal, batchBefore);
    run.afterTotal = addMoney(run.afterTotal, batchAfter);

    // A dry-run advances only this in-memory scan cursor, never its checkpoint.
    cursor = nextCheckpoint;
    if (dependencies.wait !== undefined) await dependencies.wait();
  }
}
