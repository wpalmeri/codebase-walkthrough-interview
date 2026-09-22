import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test(
  "tenant API-key administration is scoped, audited, transactional, and never replays a one-time token",
  { timeout: 45_000 },
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "meridian-tenant-api-key-admin-"));
    const environment = {
      ...process.env,
      DATABASE_URL: `file:${join(temporaryDirectory, "integration.db")}`,
      RUST_LOG: "info",
    };
    try {
      execFileSync(process.execPath, ["x", "prisma", "migrate", "deploy"], {
        cwd: process.cwd(), env: environment, stdio: "pipe",
      });
      execFileSync("node", ["--import", "tsx", join(process.cwd(), "src/views/tenantApiKeysView.integration.scenario.ts")], {
        cwd: process.cwd(), env: environment, stdio: "pipe",
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
);
