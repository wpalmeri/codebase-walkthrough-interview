import { z } from "zod";
import { prisma } from "../db";
import { runTenantContractPreflight } from "./tenantContractPreflight";

const EnvironmentSchema = z.object({
  TENANT_CONTRACT_PREFLIGHT_MAX_SAMPLES: z.coerce.number().int().min(1).max(25).default(10),
});

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const result = await runTenantContractPreflight({ maxIssueSamples: environment.TENANT_CONTRACT_PREFLIGHT_MAX_SAMPLES });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
