import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test("v1 Invoice ETags use CAS and invalidate for aggregate evidence", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "meridian-invoice-conditional-"));
  const environment = {
    ...process.env,
    DATABASE_URL: `file:${join(directory, "integration.db")}`,
    // Prisma's schema engine otherwise fails opaquely in this isolated child
    // process on the current runtime; keep its normal diagnostic channel open.
    RUST_LOG: "info",
  };
  try {
    await cp(join(process.cwd(), "prisma"), join(directory, "prisma"), {
      recursive: true,
      // Recreate the deployed history immediately before this migration, then
      // apply this migration after inserting a legacy null-version row.
      filter: (source) =>
        !source.includes("20260922160000_invoice_conditional_writes") &&
        !source.includes("20260922170000_catalog_cursor_pagination"),
    });
    execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy", "--schema", join(directory, "prisma/schema.prisma")], { cwd: directory, env: environment, stdio: "pipe" });
    execFileSync("node", ["--import", "tsx", join(process.cwd(), "src/views/invoiceConditionalWrite.integration.scenario.ts")], { cwd: process.cwd(), env: environment, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
