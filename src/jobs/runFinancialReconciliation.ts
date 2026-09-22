import { z } from "zod";
import { prisma } from "../db";
import { runFinancialReconciliation } from "./financialReconciliation";

const EnvironmentSchema = z.object({
  RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  RECONCILIATION_MAX_BATCHES_PER_ENTITY: z.coerce.number().int().min(1).max(10_000).default(1_000),
});

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const result = await runFinancialReconciliation({
    batchSize: environment.RECONCILIATION_BATCH_SIZE,
    maxBatchesPerEntity: environment.RECONCILIATION_MAX_BATCHES_PER_ENTITY,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.state === "VIOLATIONS") process.exitCode = 1;
  else if (result.state === "INCOMPLETE") process.exitCode = 2;
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
