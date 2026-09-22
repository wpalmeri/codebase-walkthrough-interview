import assert from "node:assert/strict";
import { prisma } from "./db";

interface NamedRow {
  readonly name: string;
}

async function main(): Promise<void> {
  const migrations = await prisma.$queryRaw<NamedRow[]>`
    SELECT migration_name AS name
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL
    ORDER BY migration_name
  `;
  assert.deepEqual(
    migrations.map(({ name }) => name),
    [
      "20260921000000_baseline",
      "20260922000000_financial_integrity_foundation",
      "20260922010000_currency_foundation",
      "20260922020000_order_amount_foundation",
      "20260922030000_accounting_close",
      "20260922040000_backfill_checkpoints",
      "20260922050000_idempotency_records",
      "20260922060000_usd_currency_policy",
    ]
  );

  const requiredTriggers = [
    "InvoiceLine_posted_update_guard",
    "Invoice_accounting_date_update_guard",
    "Invoice_currency_code_update_guard",
    "Invoice_status_update_guard",
    "Order_status_update_guard",
    "PaymentApplication_currency_insert_guard",
    "Payment_supported_currency_insert_guard",
  ];
  const triggers = await prisma.$queryRaw<NamedRow[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger'
    ORDER BY name
  `;
  const installed = new Set(triggers.map(({ name }) => name));
  for (const trigger of requiredTriggers) {
    assert.equal(installed.has(trigger), true, `missing migration trigger ${trigger}`);
  }

  await prisma.customer.create({
    data: { id: "migration-customer", name: "Migration Test", email: "test@example.com" },
  });
  await prisma.order.create({
    data: { id: "migration-order", customerId: "migration-customer" },
  });
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Order" SET "status" = 'NOT_A_STATUS' WHERE "id" = 'migration-order'`,
    /invalid Order\.status transition/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Order" ("id", "customerId", "status", "currencyCode", "orderDate")
      VALUES ('unsupported-currency-order', 'migration-customer', 'OPEN', 'EUR', CURRENT_TIMESTAMP)
    `,
    /Order\.currencyCode must be USD/u
  );
}

void main().finally(() => prisma.$disconnect());
