import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { runArchitectureIntegrity } from "./architectureIntegrity";

const temporaryRoots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "meridian-architecture-"));
  temporaryRoots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("architecture integrity guard", () => {
  test("accepts the current migration tree", async () => {
    const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    expect(await runArchitectureIntegrity(repositoryRoot)).toEqual([]);
  });

  test("accepts legacy compatibility boundaries and Zod-inferred shared models", async () => {
    const root = await fixture({
      "prisma/schema.prisma": "model Product {\n  listPrice Float\n}\n",
      "src/domain/money.ts": "export const legacy = (value: string) => Number(value);\n",
      "src/controllers/paymentController.ts": "prisma.paymentApplication.create({});\n",
      "packages/contracts/src/payment.ts": [
        "import { z } from 'zod';",
        "export const PaymentResponseSchema = z.object({ id: z.string() });",
        "export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;",
      ].join("\n"),
    });

    expect(await runArchitectureIntegrity(root)).toEqual([]);
  });

  test("reports every rule against temporary violating source fixtures", async () => {
    const root = await fixture({
      "prisma/schema.prisma": "model Product {\n  listPrice Float\n  surcharge Float\n}\n",
      "src/domain/unsafeAmount.ts": "const amount = Number(input);\nconst quantity = +input;\nconst rate = parseFloat(input);\n",
      "src/services/ledgerBypass.ts": [
        "prisma.paymentApplication.create({ data: {} });",
        "prisma.paymentApplicationReversal.delete({ where: { id } });",
        "prisma.paymentApplicationReversal",
        "  .update({ where: { id } });",
      ].join("\n"),
      "packages/contracts/src/invoice.ts": "export interface InvoiceResponse { id: string }\n",
    });

    const output = await runArchitectureIntegrity(root);

    expect(output.map((item) => `${item.ruleId} ${item.path}:${item.line}`)).toEqual([
      "ARCH004 packages/contracts/src/invoice.ts:1",
      "ARCH001 prisma/schema.prisma:3",
      "ARCH002 src/domain/unsafeAmount.ts:1",
      "ARCH002 src/domain/unsafeAmount.ts:2",
      "ARCH002 src/domain/unsafeAmount.ts:3",
      "ARCH003 src/services/ledgerBypass.ts:1",
      "ARCH003 src/services/ledgerBypass.ts:2",
      "ARCH003 src/services/ledgerBypass.ts:3",
    ]);
  });

  test("requires lifecycle fields to retain their generated Prisma enum types", async () => {
    const root = await fixture({
      "prisma/schema.prisma": [
        "model Order {",
        "  status String",
        "}",
        "model Invoice {",
        "  status InvoiceStatus",
        "}",
        "model Transmission {",
        "  method String",
        "  status String",
        "}",
        "model IdempotencyRecord {",
        "  method IdempotencyHttpMethod",
        "  state String",
        "}",
        "model AuditEvent {",
        "  action String",
        "  principalKind String",
        "  resourceKind String",
        "}",
      ].join("\n"),
    });

    expect(await runArchitectureIntegrity(root)).toEqual([
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 2,
        message: "lifecycle field Order.status must use Prisma enum OrderStatus, not String",
      },
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 8,
        message: "lifecycle field Transmission.method must use Prisma enum TransmissionMethod, not String",
      },
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 9,
        message: "lifecycle field Transmission.status must use Prisma enum TransmissionStatus, not String",
      },
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 13,
        message: "lifecycle field IdempotencyRecord.state must use Prisma enum IdempotencyRecordState, not String",
      },
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 16,
        message: "lifecycle field AuditEvent.action must use Prisma enum AuditAction, not String",
      },
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 17,
        message: "lifecycle field AuditEvent.principalKind must use Prisma enum AuditPrincipalKind, not String",
      },
      {
        ruleId: "ARCH005",
        path: "prisma/schema.prisma",
        line: 18,
        message: "lifecycle field AuditEvent.resourceKind must use Prisma enum AuditResourceKind, not String",
      },
    ]);
  });

  test("permits additive DDL and row-level trigger DML while ignoring comments, strings, and casing", async () => {
    const root = await fixture({
      "prisma/migrations/20260923000000_safe/migration.sql": [
        "-- DROP TABLE and UPDATE in comments are not executable SQL.",
        "CrEaTe TABLE \"NewAudit\" (\"id\" TEXT NOT NULL PRIMARY KEY);",
        "ALTER TABLE \"NewAudit\" ADD COLUMN \"note\" TEXT DEFAULT 'DELETE FROM Customer';",
        "CREATE TRIGGER \"NewAudit_row_guard\"",
        "AFTER INSERT ON \"NewAudit\"",
        "BEGIN",
        "  uPdAtE \"NewAudit\" SET \"note\" = 'update is data' WHERE \"id\" = NEW.\"id\";",
        "  DELETE FROM \"NewAudit\" WHERE \"id\" = 'never-matches';",
        "END;",
      ].join("\n"),
    });

    expect(await runArchitectureIntegrity(root)).toEqual([]);
  });

  test("rejects destructive, rebuild, top-level data, and ambiguous migration SQL with stable locations", async () => {
    const root = await fixture({
      "prisma/migrations/20260923000000_drop_table/migration.sql": "-- never deploy this\nDROP TABLE \"Invoice\";\n",
      "prisma/migrations/20260923000001_drop_column/migration.sql": "ALTER TABLE \"Invoice\" DROP COLUMN \"total\";\n",
      "prisma/migrations/20260923000001a_drop_index/migration.sql": "DROP INDEX \"Invoice_number_key\";\n",
      "prisma/migrations/20260923000002_rename/migration.sql": "ALTER TABLE \"Invoice\" RENAME TO \"Invoice_old\";\n",
      "prisma/migrations/20260923000003_backfill/migration.sql": "-- a comment cannot conceal a top-level backfill\nuPdAtE \"Invoice\"\nSET \"status\" = 'POSTED';\n",
      "prisma/migrations/20260923000004_table_as_select/migration.sql": "CREATE TABLE \"Invoice_copy\" AS\nSELECT * FROM \"Invoice\";\n",
      "prisma/migrations/20260923000005_cte_bypass/migration.sql": "WITH rows AS (SELECT * FROM \"Invoice\") DELETE FROM \"Invoice\";\n",
      "prisma/migrations/20260923000006_unterminated/migration.sql": "CREATE TABLE \"unterminated (id TEXT);\n",
      "prisma/migrations/20260923000007_trigger_bypass/migration.sql": [
        "CREATE TRIGGER \"row_guard\" AFTER INSERT ON \"Invoice\" BEGIN",
        "  UPDATE \"Invoice\" SET \"status\" = 'POSTED' WHERE \"id\" = NEW.\"id\";",
        "  -- A comment with END; must not close the trigger.",
      ].join("\n"),
      "prisma/migrations/20260923000008_trigger_header_bypass/migration.sql": [
        "CREATE TRIGGER \"not_a_body\" AFTER INSERT ON \"Invoice\";",
        "DROP TABLE \"Invoice\";",
      ].join("\n"),
    });

    expect((await runArchitectureIntegrity(root)).map((item) => `${item.ruleId} ${item.path}:${item.line}`)).toEqual([
      "MIG001 prisma/migrations/20260923000000_drop_table/migration.sql:2",
      "MIG001 prisma/migrations/20260923000001_drop_column/migration.sql:1",
      "MIG001 prisma/migrations/20260923000001a_drop_index/migration.sql:1",
      "MIG002 prisma/migrations/20260923000002_rename/migration.sql:1",
      "MIG003 prisma/migrations/20260923000003_backfill/migration.sql:2",
      "MIG003 prisma/migrations/20260923000004_table_as_select/migration.sql:1",
      "MIG004 prisma/migrations/20260923000005_cte_bypass/migration.sql:1",
      "MIG005 prisma/migrations/20260923000006_unterminated/migration.sql:1",
      "MIG005 prisma/migrations/20260923000007_trigger_bypass/migration.sql:2",
      "MIG005 prisma/migrations/20260923000008_trigger_header_bypass/migration.sql:1",
      "MIG001 prisma/migrations/20260923000008_trigger_header_bypass/migration.sql:2",
    ]);
  });
});
