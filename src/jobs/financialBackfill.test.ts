import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  runFinancialBackfill,
  type FinancialBackfillRepository,
  type FinancialBackfillRow,
} from "./financialBackfill";

type Write = { readonly id: string };

const rows: readonly FinancialBackfillRow[] = [
  { id: "a", beforeAmount: "0.1000" },
  { id: "b", beforeAmount: "0.2000" },
  { id: "c", beforeAmount: "0.3000" },
];

function repository(
  source: readonly FinancialBackfillRow[],
  failTransactions = 0
): FinancialBackfillRepository<FinancialBackfillRow, Write> & {
  readonly writes: Write[];
  readonly checkpoints: string[];
  readonly cursors: (string | null)[];
} {
  let checkpoint: string | null = null;
  let failuresRemaining = failTransactions;
  const writes: Write[] = [];
  const checkpoints: string[] = [];
  const cursors: (string | null)[] = [];
  return {
    writes,
    checkpoints,
    cursors,
    async loadCheckpoint() {
      return checkpoint;
    },
    async fetchAfter(afterId, limit) {
      cursors.push(afterId);
      return source.filter((row) => afterId === null || row.id > afterId).slice(0, limit);
    },
    async transaction(operation) {
      const stagedWrites: Write[] = [];
      let stagedCheckpoint: string | undefined;
      const value = await operation({
        async writeRows(nextWrites) {
          stagedWrites.push(...nextWrites);
        },
        async saveCheckpoint(_jobName, nextCheckpoint) {
          stagedCheckpoint = nextCheckpoint;
        },
      });
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("simulated interrupted transaction");
      }
      writes.push(...stagedWrites);
      if (stagedCheckpoint !== undefined) {
        checkpoint = stagedCheckpoint;
        checkpoints.push(stagedCheckpoint);
      }
      return value;
    },
  };
}

const exactTransform = (row: FinancialBackfillRow) => ({
  kind: "ready" as const,
  afterAmount: row.beforeAmount,
  write: { id: row.id },
});

void describe("financial backfill", () => {
  void test("restarts a failed batch from its old checkpoint without skipping rows", async () => {
    const store = repository(rows, 1);
    await assert.rejects(
      runFinancialBackfill(
        { jobName: "decimal-v1", batchSize: 2 },
        { repository: store, transform: exactTransform }
      ),
      /simulated interrupted transaction/
    );
    assert.equal(store.writes.length, 0);
    assert.equal(store.checkpoints.length, 0);

    const finished = await runFinancialBackfill(
      { jobName: "decimal-v1", batchSize: 2 },
      { repository: store, transform: exactTransform }
    );
    assert.equal(finished.state, "COMPLETE");
    assert.deepEqual(store.writes.map((write) => write.id), ["a", "b", "c"]);
    assert.deepEqual(store.checkpoints, ["b", "c"]);
    assert.deepEqual(store.cursors, [null, null, "b", "c"]);
  });

  void test("dry-runs every batch without writes or persistent checkpoint advancement", async () => {
    const store = repository(rows.slice(0, 2));
    let waits = 0;
    const result = await runFinancialBackfill(
      { jobName: "decimal-v1", batchSize: 1, dryRun: true },
      {
        repository: store,
        transform: exactTransform,
        async wait() {
          waits += 1;
        },
      }
    );
    assert.equal(result.state, "COMPLETE");
    assert.equal(result.checkpoint, null);
    assert.equal(result.rowsRead, 2);
    assert.equal(result.rowsWritten, 0);
    assert.equal(waits, 2);
    assert.equal(store.writes.length, 0);
    assert.equal(store.checkpoints.length, 0);
  });

  void test("reconciles exact decimal row totals across deterministically ordered batches", async () => {
    const store = repository(rows);
    const transformedIds: string[] = [];
    const result = await runFinancialBackfill(
      { jobName: "decimal-v1", batchSize: 2 },
      {
        repository: store,
        transform(row) {
          transformedIds.push(row.id);
          return exactTransform(row);
        },
      }
    );
    assert.equal(result.beforeTotal, "0.6000");
    assert.equal(result.afterTotal, "0.6000");
    assert.equal(result.mismatchedRows, 0);
    assert.deepEqual(transformedIds, ["a", "b", "c"]);
  });

  void test("accepts concrete rows with additional reconciliation facts", async () => {
    const concreteRows: readonly (FinancialBackfillRow & { readonly legacyTotal: number })[] = [
      { id: "a", beforeAmount: "0.1000", legacyTotal: 0.1 },
    ];
    const store = repository(concreteRows);
    const result = await runFinancialBackfill(
      { jobName: "concrete-v1" },
      { repository: store, transform: exactTransform }
    );

    assert.equal(result.state, "COMPLETE");
    assert.deepEqual(store.writes, [{ id: "a" }]);
  });

  void test("stops before a write when a configurable row mismatch threshold is crossed", async () => {
    const store = repository(rows.slice(0, 1));
    const result = await runFinancialBackfill(
      { jobName: "decimal-v1", maxMismatchedRows: 0, requireExactTotals: false },
      {
        repository: store,
        transform(row) {
          return { kind: "ready", afterAmount: "0.2000", write: { id: row.id } };
        },
      }
    );
    assert.equal(result.state, "PARTIAL");
    assert.deepEqual(result.stop, {
      code: "MISMATCH_THRESHOLD_EXCEEDED",
      detail: "Backfill row mismatch threshold was exceeded",
      rowId: "a",
    });
    assert.equal(store.writes.length, 0);
    assert.equal(store.checkpoints.length, 0);
  });

  void test("stops on typed unsafe historical rows instead of fabricating terms", async () => {
    const store = repository(rows.slice(0, 1));
    const result = await runFinancialBackfill(
      { jobName: "snapshot-v1" },
      {
        repository: store,
        transform() {
          return {
            kind: "unsafe",
            code: "MISSING_RATE_SNAPSHOT",
            detail: "The historical rate inputs are unavailable",
          };
        },
      }
    );
    assert.equal(result.state, "PARTIAL");
    assert.equal(result.stop?.code, "MISSING_RATE_SNAPSHOT");
    assert.equal(result.checkpoint, null);
    assert.equal(store.writes.length, 0);
  });

  void test("refuses an out-of-order repository response rather than advancing an unsafe cursor", async () => {
    const store = repository([rows[1], rows[0]]);
    const result = await runFinancialBackfill(
      { jobName: "decimal-v1" },
      { repository: store, transform: exactTransform }
    );
    assert.equal(result.state, "PARTIAL");
    assert.equal(result.stop?.code, "UNSTABLE_PRIMARY_KEY_ORDER");
    assert.equal(store.writes.length, 0);
  });
});
