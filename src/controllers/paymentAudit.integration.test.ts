import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test(
  "payment mutations atomically append global request audit evidence",
  { timeout: 45_000 },
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "meridian-payment-audit-"));
    const environment = {
      ...process.env,
      DATABASE_URL: `file:${join(temporaryDirectory, "integration.db")}`,
      RUST_LOG: "info",
    };
    try {
      execFileSync(process.execPath, ["x", "prisma", "migrate", "deploy"], {
        cwd: process.cwd(),
        env: environment,
        stdio: "pipe",
      });
      execFileSync(process.execPath, [join(process.cwd(), "src/controllers/paymentAudit.integration.scenario.ts")], {
        cwd: process.cwd(),
        env: environment,
        stdio: "pipe",
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
);
