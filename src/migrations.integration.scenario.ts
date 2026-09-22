import assert from "node:assert/strict";
import { prisma } from "./db";

type NamedRow = { readonly name: string };
type NumericRow = { readonly resourceVersion: number | null };
type ColumnRow = { readonly name: string };

const expectedMigrations = [
  "20260921000000_baseline",
  "20260922000000_financial_integrity_foundation",
  "20260922010000_currency_foundation",
  "20260922020000_order_amount_foundation",
  "20260922030000_accounting_close",
  "20260922040000_backfill_checkpoints",
  "20260922050000_idempotency_records",
  "20260922060000_usd_currency_policy",
  "20260922070000_ledger_immutability_guards",
  "20260922080000_payment_application_reversals",
  "20260922090000_operator_api_key_foundation",
  "20260922100000_resource_versions",
  "20260922110000_rate_conditional_writes",
  "20260922120000_payment_cursor_pagination",
  "20260922130000_audit_events",
  "20260922140000_order_conditional_writes",
  "20260922150000_customer_email_guard",
  "20260922160000_invoice_conditional_writes",
  "20260922170000_catalog_cursor_pagination",
  "20260922180000_order_cursor_pagination",
  "20260922190000_invoice_cursor_pagination",
  "20260922200000_operator_api_key_admin_guard",
  "20260922210000_accounting_close_hardening",
] as const;

const requiredTriggers = [
  "InvoiceLine_posted_update_guard",
  "Invoice_accounting_date_update_guard",
  "Invoice_currency_code_update_guard",
  "Invoice_status_update_guard",
  "Order_status_update_guard",
  "PaymentApplication_currency_insert_guard",
  "Payment_supported_currency_insert_guard",
  "PaymentApplicationReversal_append_only_update_guard",
  "PaymentApplicationReversal_amount_guard",
  "Invoice_reversal_status_evidence_guard",
  "Customer_resource_version_insert_guard",
  "Customer_resource_version_update_guard",
  "Product_resource_version_insert_guard",
  "Product_resource_version_update_guard",
  "Rate_resource_version_insert_guard",
  "Rate_resource_version_update_guard",
  "ComboDiscount_resource_version_insert_guard",
  "ComboDiscount_resource_version_update_guard",
  "Order_resource_version_insert_guard",
  "Order_resource_version_update_guard",
  "Invoice_resource_version_insert_guard",
  "Invoice_resource_version_update_guard",
  "Rate_resource_version_initialize",
  "Rate_resource_version_business_update_bump",
  "AuditEvent_append_only_update_guard",
  "AuditEvent_append_only_delete_guard",
  "AuditEvent_insert_guard",
  "Order_resource_version_initialize",
  "Order_resource_version_business_update_bump",
  "OrderItem_order_version_insert_bump",
  "OrderComment_order_version_insert_bump",
  "Invoice_order_version_insert_bump",
  "Customer_email_insert_guard",
  "Customer_email_update_guard",
  "Invoice_resource_version_initialize",
  "Invoice_resource_version_business_update_bump",
  "InvoiceLine_invoice_version_insert_bump",
  "PaymentApplication_invoice_version_insert_bump",
  "Transmission_invoice_version_insert_bump",
  "OperatorApiKey_input_guard",
  "OperatorApiKey_identity_immutability_guard",
  "OperatorApiKey_retain_active_admin_update_guard",
  "OperatorApiKey_retain_active_admin_delete_guard",
  "AccountingPeriodControl_delete_guard",
  "Invoice_finalized_accounting_date_required_insert_guard",
  "Invoice_finalized_accounting_date_required_update_guard",
  "PaymentApplicationReversal_closed_period_insert_guard",
] as const;

async function main(): Promise<void> {
  const migrations = await prisma.$queryRaw<NamedRow[]>`
    SELECT migration_name AS name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL ORDER BY migration_name
  `;
  assert.deepEqual(migrations.map(({ name }) => name), expectedMigrations);

  const triggers = await prisma.$queryRaw<NamedRow[]>`
    SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
  `;
  const installedTriggers = new Set(triggers.map(({ name }) => name));
  for (const name of requiredTriggers) assert.equal(installedTriggers.has(name), true, `missing migration trigger ${name}`);

  const requiredIndexes = [
    "OperatorApiKey_revokedAt_idx",
    "Payment_receivedAt_id_idx",
    "Customer_name_id_idx",
    "Product_sku_id_idx",
    "Order_orderDate_id_idx",
    "Invoice_issueDate_id_idx",
    "AuditEvent_occurredAt_id_idx",
    "AuditEvent_resourceKind_resourceId_occurredAt_idx",
  ];
  const indexes = await prisma.$queryRaw<NamedRow[]>`
    SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
  `;
  const installedIndexes = new Set(indexes.map(({ name }) => name));
  for (const name of requiredIndexes) assert.equal(installedIndexes.has(name), true, `missing global index ${name}`);

  const tables = await prisma.$queryRaw<NamedRow[]>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  assert.equal(tables.some(({ name }) => name === "Tenant"), false, "the billing database has no tenant table");
  for (const table of ["Customer", "Product", "ComboDiscount", "Order", "Invoice", "Payment", "IdempotencyRecord", "AuditEvent"]) {
    const columns = await prisma.$queryRaw<ColumnRow[]>`SELECT name FROM pragma_table_info(${table})`;
    assert.equal(columns.some(({ name }) => name === "tenantId"), false, `${table} must not carry a tenant scope`);
  }

  await prisma.customer.create({ data: { id: "migration-customer", name: "Migration Test", email: "test@example.com" } });
  await prisma.order.create({ data: { id: "migration-order", customerId: "migration-customer", currencyCode: "USD" } });
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

  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "OperatorApiKey" ("id", "name", "role", "keyPrefix", "keyHash")
      VALUES ('invalid-operator-role', 'invalid role', 'ROOT', 'mrd_invalidrole', '01234567890123456789012345678901')
    `,
    /OperatorApiKey_role_check/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "OperatorApiKey" ("id", "name", "role", "keyPrefix", "keyHash")
      VALUES ('invalid-operator-input', '', 'ADMIN', 'mrd_invalidinput', '01234567890123456789012345678901')
    `,
    /invalid OperatorApiKey input/u
  );
  await prisma.operatorApiKey.create({
    data: {
      id: "operator-admin-one", name: "only admin", role: "ADMIN",
      keyPrefix: "mrd_operatorone", keyHash: "hmac-sha256:v1:1111111111111111111111111111111111111111111111111111111111111111",
    },
  });
  await assert.rejects(
    prisma.operatorApiKey.update({ where: { id: "operator-admin-one" }, data: { revokedAt: new Date() } }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2003"
  );
  await prisma.operatorApiKey.create({
    data: {
      id: "operator-admin-two", name: "backup admin", role: "ADMIN",
      keyPrefix: "mrd_operatortwo", keyHash: "hmac-sha256:v1:2222222222222222222222222222222222222222222222222222222222222222",
    },
  });
  await prisma.operatorApiKey.update({ where: { id: "operator-admin-one" }, data: { revokedAt: new Date() } });
  await assert.rejects(
    prisma.operatorApiKey.update({ where: { id: "operator-admin-two" }, data: { role: "VIEWER" } }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2003"
  );

  await prisma.$executeRaw`
    INSERT INTO "AuditEvent" (
      "id", "action", "principalKind", "principalSubject", "principalCredentialId",
      "requestId", "resourceKind", "resourceId", "occurredAt"
    ) VALUES (
      'global-audit-event', 'OPERATOR_API_KEY_ISSUED', 'OPERATOR_API_KEY', 'operator:test',
      'operator-admin-two', 'migration-audit-request', 'OPERATOR_API_KEY', 'operator-admin-two', CURRENT_TIMESTAMP
    )
  `;
  await assert.rejects(
    prisma.$executeRaw`UPDATE "AuditEvent" SET "resourceId" = 'changed' WHERE "id" = 'global-audit-event'`,
    /AuditEvent rows are append-only/u
  );

  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Invoice" ("id", "number", "customerId", "orderId", "status", "issueDate", "dueDate", "total", "amountPaid", "currencyCode")
      VALUES ('undated-finalized-invoice', 'MIGRATION-UNDATED', 'migration-customer', 'migration-order', 'POSTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 0, 'USD')
    `,
    /a finalized invoice requires an accounting date/u
  );
  await prisma.$executeRaw`
    INSERT INTO "Invoice" ("id", "number", "customerId", "orderId", "status", "issueDate", "dueDate", "total", "amountPaid", "accountingDate", "currencyCode")
    VALUES ('migration-invoice', 'MIGRATION-INVOICE', 'migration-customer', 'migration-order', 'POSTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 0, '2026-02-01', 'USD')
  `;
  await prisma.$executeRaw`
    INSERT INTO "AccountingPeriodControl" ("id", "closedThroughDate") VALUES (1, '2026-01-31')
  `;
  await assert.rejects(
    prisma.$executeRaw`DELETE FROM "AccountingPeriodControl" WHERE "id" = 1`,
    /accounting control cannot be deleted/u
  );
  await prisma.order.create({ data: { id: "closed-period-order", customerId: "migration-customer", currencyCode: "USD" } });
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Invoice" ("id", "number", "customerId", "orderId", "status", "issueDate", "dueDate", "total", "amountPaid", "accountingDate", "currencyCode")
      VALUES ('closed-period-invoice', 'MIGRATION-CLOSED', 'migration-customer', 'closed-period-order', 'POSTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 0, '2026-01-31', 'USD')
    `,
    /cannot post an invoice into a closed accounting period/u
  );

  await prisma.$executeRaw`
    INSERT INTO "Customer" ("id", "name", "email") VALUES ('version-customer', 'Versioned Customer', 'version-customer@example.com')
  `;
  await prisma.$executeRaw`UPDATE "Customer" SET "resourceVersion" = 5 WHERE "id" = 'version-customer'`;
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Customer" SET "resourceVersion" = 4 WHERE "id" = 'version-customer'`,
    /Customer\.resourceVersion must increase monotonically/u
  );
  await prisma.$executeRaw`
    INSERT INTO "Product" ("id", "sku", "name", "unit", "listPrice") VALUES ('version-product', 'version-product', 'Version Product', 'seat', 1)
  `;
  await prisma.$executeRaw`
    INSERT INTO "Rate" ("id", "customerId", "productId", "unitPrice", "effectiveDate") VALUES ('versioned-rate', 'version-customer', 'version-product', 1, CURRENT_TIMESTAMP)
  `;
  let version = await prisma.$queryRaw<NumericRow[]>`SELECT "resourceVersion" FROM "Rate" WHERE "id" = 'versioned-rate'`;
  assert.equal(version[0]?.resourceVersion, 1);
  await prisma.$executeRaw`UPDATE "Rate" SET "unitPrice" = 2 WHERE "id" = 'versioned-rate'`;
  version = await prisma.$queryRaw<NumericRow[]>`SELECT "resourceVersion" FROM "Rate" WHERE "id" = 'versioned-rate'`;
  assert.equal(version[0]?.resourceVersion, 2);
}

void main().finally(() => prisma.$disconnect());
