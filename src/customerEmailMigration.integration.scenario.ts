import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { prisma } from "./db";

const migration = join(
  process.cwd(),
  "prisma/migrations/20260922150000_customer_email_guard/migration.sql"
);

async function rejectEmail(id: string, email: string): Promise<void> {
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Customer" ("id", "name", "email")
      VALUES (${id}, ${id}, ${email})
    `,
    /Customer\.email is not a structurally valid delivery address/u
  );
  assert.equal(await prisma.customer.count({ where: { id } }), 0);
}

async function main(): Promise<void> {
  try {
    await prisma.customer.create({
      data: { id: "legacy-invalid-email", name: "Legacy invalid email", email: "legacy-invalid" },
    });

    execFileSync(
      join(process.cwd(), "node_modules/.bin/prisma"),
      ["db", "execute", "--url", process.env.DATABASE_URL ?? "", "--file", migration],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" }
    );

    // The deploy does not inspect history, and unrelated maintenance remains
    // possible while an operator reconciles a pre-existing invalid address.
    await prisma.customer.update({
      where: { id: "legacy-invalid-email" },
      data: { name: "Legacy invalid email retained" },
    });
    assert.equal(
      (await prisma.customer.findUniqueOrThrow({ where: { id: "legacy-invalid-email" } })).email,
      "legacy-invalid"
    );

    const rejectedAddresses = [
      ["email-missing-at", "billing.example.com"],
      ["email-two-at", "billing@@example.com"],
      ["email-leading-space", " billing@example.com"],
      ["email-crlf", "billing@example.com\r\nBcc: attacker@example.com"],
      ["email-domain", "billing@example"],
      ["email-local-too-long", `${"a".repeat(65)}@example.com`],
      ["email-too-long", `${"a".repeat(64)}@${"b".repeat(190)}.com`],
    ] as const;
    // SQLite has one writer; exercise each trigger failure deterministically
    // rather than turning the validation test into a lock-contention test.
    for (const [id, email] of rejectedAddresses) await rejectEmail(id, email);

    const valid = await prisma.customer.create({
      data: { id: "email-valid", name: "Valid email", email: "billing+invoices@example.com" },
    });
    assert.equal(valid.email, "billing+invoices@example.com");
    await assert.rejects(
      prisma.$executeRaw`
        UPDATE "Customer" SET "email" = 'not-deliverable' WHERE "id" = ${valid.id}
      `,
      /Customer\.email is not a structurally valid delivery address/u
    );
    assert.equal(
      (await prisma.customer.findUniqueOrThrow({ where: { id: valid.id } })).email,
      "billing+invoices@example.com"
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
