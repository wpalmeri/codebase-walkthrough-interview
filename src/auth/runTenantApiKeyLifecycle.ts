import { prisma } from "../db";
import {
  issueTenantApiKey,
  parseTenantApiKeyCliCommand,
  revokeTenantApiKey,
  serializeTenantApiKeyCliResult,
  TenantApiKeyLifecycleError,
} from "./tenantApiKeyLifecycle";
import { ApiKeyPepperSchema } from "./tenantPrincipal";

async function main(): Promise<void> {
  const command = parseTenantApiKeyCliCommand(process.argv.slice(2));
  const pepper = ApiKeyPepperSchema.parse(process.env.MERIDIAN_API_KEY_PEPPER);
  if (command.action === "issue") {
    const key = await issueTenantApiKey(prisma, command.input, pepper);
    // The token appears only in this successful, explicitly requested output.
    process.stdout.write(`${serializeTenantApiKeyCliResult({ action: "issued", key })}\n`);
    return;
  }
  const key = await revokeTenantApiKey(prisma, command.input);
  process.stdout.write(`${serializeTenantApiKeyCliResult({ action: "revoked", key })}\n`);
}

void main()
  .catch((error: unknown) => {
    // Never stringify arbitrary errors: ORM metadata or a future wrapper could
    // accidentally retain operator input. Only our fixed lifecycle codes are
    // safe to disclose; validation and infrastructure failures stay generic.
    const message =
      error instanceof TenantApiKeyLifecycleError
        ? `${error.code}: ${error.message}`
        : "tenant key operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
