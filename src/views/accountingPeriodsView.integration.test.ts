import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test("tenant accounting close is authenticated, monotonic, idempotent, and audited", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "meridian-accounting-close-"));
  const environment = { ...process.env, DATABASE_URL: `file:${join(directory, "integration.db")}`, RUST_LOG: "info" };
  try {
    execFileSync(process.execPath, ["x", "prisma", "migrate", "deploy"], { cwd: process.cwd(), env: environment, stdio: "pipe" });
    execFileSync("node", ["--import", "tsx", join(process.cwd(), "src/views/accountingPeriodsView.integration.scenario.ts")], { cwd: process.cwd(), env: environment, stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
