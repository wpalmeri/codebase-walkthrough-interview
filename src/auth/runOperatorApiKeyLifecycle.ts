import { prisma } from "../db";
import { ApiKeyPepperSchema } from "./operatorPrincipal";
import {
  bootstrapOperatorApiKey,
  OperatorApiKeyAdministrationError,
  parseOperatorApiKeyCliCommand,
  type OperatorApiKeyBootstrapStore,
  type OperatorApiKeyBootstrapTransaction,
} from "./operatorApiKeyLifecycle";

const bootstrapStore: OperatorApiKeyBootstrapStore = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the bootstrap boundary exposes only the transaction delegates it needs.
  $transaction: (operation) => prisma.$transaction((transaction) => operation(transaction as unknown as OperatorApiKeyBootstrapTransaction)),
};

async function main(): Promise<void> {
  const command = parseOperatorApiKeyCliCommand(process.argv.slice(2));
  const pepper = ApiKeyPepperSchema.parse(process.env.MERIDIAN_API_KEY_PEPPER);
  if (command.action === "bootstrap") {
    const key = await bootstrapOperatorApiKey(bootstrapStore, command.input, pepper);
    // The credential appears exactly once on the directly-invoked bootstrap
    // terminal. It is never written to the database, audit event, or logs.
    process.stdout.write(`${JSON.stringify({ action: "bootstrapped", key })}\n`);
    return;
  }
  throw new Error("operator:key revoke requires an authenticated ADMIN API request; use POST /operator-api-keys/revoke");
}

void main()
  .catch((error: unknown) => {
    const message =
      error instanceof OperatorApiKeyAdministrationError
        ? `${error.code}: ${error.message}`
        : "operator key operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
