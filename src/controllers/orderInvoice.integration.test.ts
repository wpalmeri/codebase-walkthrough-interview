import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test(
  "orders and invoices remain exact and immutable after live pricing changes",
  { timeout: 30_000 },
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "meridian-order-invoice-"));
    const databaseUrl = `file:${join(temporaryDirectory, "integration.db")}`;
    const environment = { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" };

    try {
      execFileSync(process.execPath, ["x", "prisma", "migrate", "deploy"], {
        cwd: process.cwd(),
        env: environment,
        stdio: "pipe",
      });
      execFileSync(
        process.execPath,
        [join(process.cwd(), "src/controllers/orderInvoice.integration.scenario.ts")],
        { cwd: process.cwd(), env: environment, stdio: "pipe" }
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
);
