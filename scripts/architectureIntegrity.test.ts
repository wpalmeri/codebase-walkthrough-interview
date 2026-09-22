import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    ]);
  });
});
