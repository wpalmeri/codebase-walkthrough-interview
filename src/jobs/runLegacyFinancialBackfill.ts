import { z } from "zod";
import { runLegacyFinancialBackfill } from "./legacyFinancialBackfill";

const EnvironmentSchema = z.object({
  BACKFILL_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(100),
  /** Defaults to preview mode; use BACKFILL_DRY_RUN=false to write. */
  BACKFILL_DRY_RUN: z.enum(["true", "false"]).default("true"),
  BACKFILL_THROTTLE_MS: z.coerce.number().int().min(0).max(60_000).default(50),
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const result = await runLegacyFinancialBackfill({
    batchSize: environment.BACKFILL_BATCH_SIZE,
    dryRun: environment.BACKFILL_DRY_RUN === "true",
    ...(environment.BACKFILL_THROTTLE_MS === 0
      ? {}
      : { wait: () => wait(environment.BACKFILL_THROTTLE_MS) }),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== "COMPLETE") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
