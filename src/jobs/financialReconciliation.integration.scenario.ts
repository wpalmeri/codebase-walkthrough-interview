import assert from "node:assert/strict";
import { prisma } from "../db";
import { runFinancialReconciliation } from "./financialReconciliation";

async function main(): Promise<void> {
  const result = await runFinancialReconciliation({ batchSize: 2 });
  assert.equal(result.state, "CLEAN");
  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, []);
  assert.ok(result.scanned.products > 0);
  assert.ok(result.scanned.orders > 0);
  assert.ok(result.scanned.invoices > 0);
  assert.ok(result.scanned.payments > 0);
}

void main().finally(() => prisma.$disconnect());
