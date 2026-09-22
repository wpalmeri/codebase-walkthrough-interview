import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test("v1 Order writes use aggregate ETags and atomic CAS", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "meridian-order-conditional-"));
  const environment = {
    ...process.env,
    DATABASE_URL: `file:${join(directory, "integration.db")}`,
    RUST_LOG: "info",
  };
  const copiedPrisma = join(directory, "prisma");
  try {
    await cp(join(process.cwd(), "prisma"), copiedPrisma, {
      recursive: true,
      filter: (source) => !source.includes("20260922140000_order_conditional_writes"),
    });
    execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy", "--schema", join(copiedPrisma, "schema.prisma")], {
      cwd: directory, env: environment, stdio: "pipe",
    });
    execFileSync("node", ["--import", "tsx", join(process.cwd(), "src/views/orderConditionalWrite.integration.scenario.ts")], {
      cwd: process.cwd(), env: environment, stdio: "pipe",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
