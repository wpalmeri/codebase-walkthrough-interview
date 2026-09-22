import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test(
  "version-one rate writes use ETags, atomic CAS, and exact idempotent replay",
  { timeout: 45_000 },
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "meridian-rate-conditional-write-"));
    const databaseUrl = `file:${join(temporaryDirectory, "integration.db")}`;
    const environment = { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" };
    const temporaryPrismaDirectory = join(temporaryDirectory, "prisma");

    try {
      // Apply the production history through the version-column expansion, seed
      // a genuinely old null-version Rate, then apply this migration exactly as
      // it will be deployed. That catches unsafe assumptions hidden by fresh
      // rows that are born at version one.
      await cp(join(process.cwd(), "prisma"), temporaryPrismaDirectory, {
        recursive: true,
        filter: (source) => !source.includes("20260922110000_rate_conditional_writes"),
      });
      execFileSync(
        process.execPath,
        ["x", "prisma", "migrate", "deploy", "--schema", join(temporaryPrismaDirectory, "schema.prisma")],
        { cwd: process.cwd(), env: environment, stdio: "pipe" }
      );
      execFileSync(process.execPath, [join(process.cwd(), "src/views/rateConditionalWrite.integration.scenario.ts")], {
        cwd: process.cwd(),
        env: environment,
        stdio: "pipe",
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
);
