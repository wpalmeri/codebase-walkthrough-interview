import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { prisma } from "../db";
import { createPrismaTenantPrincipalResolver, apiKeyHash } from "./tenantPrincipal";
import {
  TenantApiKeyLifecycleError,
  issueTenantApiKey,
  parseTenantApiKeyCliCommand,
  revokeTenantApiKey,
  serializeTenantApiKeyCliResult,
  TenantApiKeyCliResultSchema,
} from "./tenantApiKeyLifecycle";

const pepper = "integration-test-pepper-with-at-least-32-characters";
const alphaSecret = "abcdefghijklmnopqrstuvwxyz123456";

function token(prefix: string, suffix = alphaSecret): string {
  return `mrd_${prefix}_${suffix}`;
}

async function expectLifecycleError(
  operation: () => Promise<unknown>,
  code: TenantApiKeyLifecycleError["code"]
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof TenantApiKeyLifecycleError && error.code === code);
}

async function main(): Promise<void> {
  await prisma.tenant.create({ data: { id: "tenant-key-lifecycle", slug: "tenant-key-lifecycle", name: "Key Lifecycle" } });

  const issuedToken = token("issuedprefix1");
  const issued = await issueTenantApiKey(
    prisma,
    { tenantId: "tenant-key-lifecycle", name: "production billing", role: "BILLING" },
    pepper,
    { tokenGenerator: () => issuedToken }
  );
  assert.equal(issued.token, issuedToken);
  assert.equal(issued.keyPrefix, "mrd_issuedprefix1");

  const stored = await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: issued.id } });
  assert.equal(stored.keyPrefix, issued.keyPrefix);
  assert.equal(stored.keyHash, apiKeyHash(issuedToken, pepper));
  assert.equal(JSON.stringify(stored).includes(alphaSecret), false, "the database row must not retain the plaintext token secret");
  assert.deepEqual(await createPrismaTenantPrincipalResolver(pepper).resolve(issuedToken), {
    tenantId: "tenant-key-lifecycle",
    subjectId: "tenant:tenant-key-lifecycle",
    credentialId: issued.id,
    kind: "TENANT_API_KEY",
    role: "BILLING",
  });

  const revoked = await revokeTenantApiKey(prisma, { keyId: issued.id }, () => new Date("2026-09-22T00:00:00.000Z"));
  assert.equal(revoked.state, "REVOKED");
  assert.equal(await createPrismaTenantPrincipalResolver(pepper).resolve(issuedToken), null, "a revoked token must fail resolution");
  const repeatedRevoke = await revokeTenantApiKey(prisma, { keyPrefix: issued.keyPrefix });
  assert.equal(repeatedRevoke.state, "ALREADY_REVOKED");
  assert.equal(repeatedRevoke.revokedAt.toISOString(), revoked.revokedAt.toISOString(), "revocation must never be overwritten");

  const beforeInvalid = await prisma.tenantApiKey.count();
  await expectLifecycleError(
    () => issueTenantApiKey(prisma, { tenantId: "missing-tenant", name: "missing", role: "ADMIN" }, pepper),
    "TENANT_NOT_FOUND"
  );
  assert.equal(await prisma.tenantApiKey.count(), beforeInvalid, "missing tenants must cause no key write");
  await assert.rejects(
    issueTenantApiKey(prisma, { tenantId: "tenant-key-lifecycle", name: "invalid", role: "ROOT" }, pepper),
    /Invalid option/u
  );
  assert.throws(() => parseTenantApiKeyCliCommand(["issue", "--tenant-id", "tenant-key-lifecycle", "--name", "x", "--role", "ROOT"]));
  assert.throws(() => parseTenantApiKeyCliCommand(["revoke", "--prefix", issuedToken]));
  assert.equal(await prisma.tenantApiKey.count(), beforeInvalid, "invalid typed input must cause no key write");

  const collisionToken = token("collision01");
  await prisma.tenantApiKey.create({
    data: {
      tenantId: "tenant-key-lifecycle",
      name: "collision holder",
      role: "VIEWER",
      keyPrefix: "mrd_collision01",
      keyHash: apiKeyHash(collisionToken, pepper),
    },
  });
  const replacementToken = token("replacement01", "0123456789abcdefghijklmnopqrstuvwxyzABCD");
  let generated = 0;
  const retried = await issueTenantApiKey(
    prisma,
    { tenantId: "tenant-key-lifecycle", name: "collision retry", role: "ADMIN" },
    pepper,
    {
      maxPrefixAttempts: 3,
      tokenGenerator: () => {
        generated += 1;
        return generated === 1 ? collisionToken : replacementToken;
      },
    }
  );
  assert.equal(retried.token, replacementToken);
  assert.equal(generated, 2, "a colliding prefix must be retried exactly once before success");

  const beforeDuplicate = await prisma.tenantApiKey.count();
  await expectLifecycleError(
    () =>
      issueTenantApiKey(
        prisma,
        { tenantId: "tenant-key-lifecycle", name: "collision retry", role: "ADMIN" },
        pepper,
        { tokenGenerator: () => token("duplicate01") }
      ),
    "KEY_NAME_CONFLICT"
  );
  assert.equal(await prisma.tenantApiKey.count(), beforeDuplicate, "duplicate key names must not create a partial credential");

  let exhaustedAttempts = 0;
  await expectLifecycleError(
    () =>
      issueTenantApiKey(
        prisma,
        { tenantId: "tenant-key-lifecycle", name: "exhausted collision", role: "VIEWER" },
        pepper,
        {
          maxPrefixAttempts: 2,
          tokenGenerator: () => {
            exhaustedAttempts += 1;
            return collisionToken;
          },
        }
      ),
    "KEY_PREFIX_COLLISION"
  );
  assert.equal(exhaustedAttempts, 2, "collision retries must be bounded");
  assert.equal(await prisma.tenantApiKey.count(), beforeDuplicate, "exhausted retries must leave no partially created key");

  const issueOutput = serializeTenantApiKeyCliResult({ action: "issued", key: issued });
  assert.equal(issueOutput.split(issuedToken).length - 1, 1, "CLI output must disclose an issued token exactly once");
  assert.equal(issueOutput.includes(stored.keyHash), false, "CLI output must never disclose the persisted digest");
  const revokeOutput = serializeTenantApiKeyCliResult({ action: "revoked", key: revoked });
  assert.equal(revokeOutput.includes(issuedToken), false, "revoke output must never contain a plaintext token");

  const cliOutput = execFileSync(
    process.execPath,
    [
      join(process.cwd(), "src/auth/runTenantApiKeyLifecycle.ts"),
      "issue",
      "--tenant-id",
      "tenant-key-lifecycle",
      "--name",
      "CLI output key",
      "--role",
      "VIEWER",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, MERIDIAN_API_KEY_PEPPER: pepper },
      encoding: "utf8",
    }
  );
  assert.equal(cliOutput.split("\n").filter(Boolean).length, 1, "the issuance CLI must write one result line");
  const cliResult = TenantApiKeyCliResultSchema.parse(JSON.parse(cliOutput));
  assert.equal(cliResult.action, "issued");
  if (cliResult.action !== "issued") throw new Error("CLI issuance did not return an issued result");
  assert.equal(cliOutput.split(cliResult.key.token).length - 1, 1, "the CLI must disclose its token exactly once");
  const cliStored = await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: cliResult.key.id } });
  assert.equal(JSON.stringify(cliStored).includes(cliResult.key.token), false, "the CLI must not persist its plaintext token");
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
