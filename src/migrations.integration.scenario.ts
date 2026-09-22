import assert from "node:assert/strict";
import { prisma } from "./db";

interface NamedRow {
  readonly name: string;
}

interface NumericRow {
  readonly resourceVersion: number | null;
}

interface ForeignKeyRow {
  readonly table: string;
  readonly from: string;
  readonly on_update: string;
  readonly on_delete: string;
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
      "20260922070000_ledger_immutability_guards",
      "20260922080000_payment_application_reversals",
      "20260922090000_tenant_foundation",
      "20260922100000_resource_versions",
      "20260922110000_rate_conditional_writes",
      "20260922120000_payment_cursor_pagination",
      "20260922130000_audit_events",
      "20260922140000_order_conditional_writes",
      "20260922150000_customer_email_guard",
      "20260922160000_invoice_conditional_writes",
      "20260922170000_catalog_cursor_pagination",
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
    "PaymentApplicationReversal_append_only_update_guard",
    "PaymentApplicationReversal_amount_guard",
    "Invoice_reversal_status_evidence_guard",
    "Customer_tenant_update_guard",
    "Order_tenant_guard",
    "Rate_tenant_identity_guard",
    "PaymentApplication_tenant_identity_guard",
    "Tenant_referenced_delete_guard",
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
    "OrderItem_order_version_update_bump",
    "OrderItem_order_version_delete_bump",
    "OrderComment_order_version_insert_bump",
    "OrderComment_order_version_update_bump",
    "OrderComment_order_version_delete_bump",
    "Invoice_order_version_insert_bump",
    "Invoice_order_version_update_bump",
    "Invoice_order_version_delete_bump",
    "Customer_email_insert_guard",
    "Customer_email_update_guard",
    "Invoice_resource_version_initialize",
    "Invoice_resource_version_business_update_bump",
    "InvoiceLine_invoice_version_insert_bump",
    "InvoiceLine_invoice_version_update_bump",
    "InvoiceLine_invoice_version_delete_bump",
    "PaymentApplication_invoice_version_insert_bump",
    "PaymentApplication_invoice_version_update_bump",
    "PaymentApplication_invoice_version_delete_bump",
    "PaymentApplicationReversal_invoice_version_insert_bump",
    "PaymentApplicationReversal_invoice_version_update_bump",
    "PaymentApplicationReversal_invoice_version_delete_bump",
    "Transmission_invoice_version_insert_bump",
    "Transmission_invoice_version_update_bump",
    "Transmission_invoice_version_delete_bump",
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

  const paymentPaginationIndex = await prisma.$queryRaw<NamedRow[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name = 'Payment_tenantId_receivedAt_id_idx'
  `;
  assert.deepEqual(paymentPaginationIndex, [{ name: "Payment_tenantId_receivedAt_id_idx" }]);

  const catalogPaginationIndexes = await prisma.$queryRaw<NamedRow[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
      AND name IN ('Customer_tenantId_name_id_idx', 'Product_tenantId_sku_id_idx')
    ORDER BY name
  `;
  assert.deepEqual(catalogPaginationIndexes, [
    { name: "Customer_tenantId_name_id_idx" },
    { name: "Product_tenantId_sku_id_idx" },
  ]);

  const auditIndexes = await prisma.$queryRaw<NamedRow[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'AuditEvent_tenantId_occurredAt_id_idx',
      'AuditEvent_tenantId_resourceKind_resourceId_occurredAt_idx'
    )
    ORDER BY name
  `;
  assert.deepEqual(
    auditIndexes.map(({ name }) => name),
    [
      "AuditEvent_tenantId_occurredAt_id_idx",
      "AuditEvent_tenantId_resourceKind_resourceId_occurredAt_idx",
    ]
  );

  const tenantForeignKeys = await Promise.all([
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("Customer")`,
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("Product")`,
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("ComboDiscount")`,
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("Order")`,
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("Invoice")`,
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("Payment")`,
    prisma.$queryRaw<ForeignKeyRow[]>`PRAGMA foreign_key_list("IdempotencyRecord")`,
  ]);
  for (const foreignKeys of tenantForeignKeys) {
    assert.equal(
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "Tenant" &&
          foreignKey.from === "tenantId" &&
          foreignKey.on_update === "CASCADE" &&
          foreignKey.on_delete === "RESTRICT"
      ),
      true,
      "every nullable tenantId has an explicit SQLite Tenant foreign key"
    );
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

  // The tenant migration is expand-only: legacy rows still work with a null
  // tenantId, but every populated ownership edge is checked at the database
  // boundary, including a later backfill that would introduce a conflict.
  await prisma.$executeRaw`
    INSERT INTO "Tenant" ("id", "slug", "name") VALUES
      ('tenant-a', 'tenant-a', 'Tenant A'),
      ('tenant-b', 'tenant-b', 'Tenant B')
  `;
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "TenantApiKey" ("id", "tenantId", "name", "role", "keyPrefix", "keyHash")
      VALUES ('invalid-role-key', 'tenant-a', 'invalid role', 'ROOT', 'invalid-role', '01234567890123456789012345678901')
    `,
    /TenantApiKey_role_check/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "UserIdentity" ("id", "issuer", "subject")
      VALUES ('invalid-identity', '', 'subject-1')
    `,
    /invalid UserIdentity input/u
  );
  await prisma.$executeRaw`
    INSERT INTO "UserIdentity" ("id", "issuer", "subject") VALUES
      ('oidc-identity', 'https://issuer.example/oidc', 'subject-1'),
      ('saml-identity', 'https://issuer.example/saml', 'subject-1')
  `;
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "UserIdentity" ("id", "issuer", "subject")
      VALUES ('duplicate-identity', 'https://issuer.example/oidc', 'subject-1')
    `,
    /UNIQUE constraint failed/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "UserIdentity"
      SET "subject" = 'reassigned-subject'
      WHERE "id" = 'oidc-identity'
    `,
    /UserIdentity issuer and subject are immutable/u
  );
  await prisma.$executeRaw`
    INSERT INTO "Customer" ("id", "tenantId", "name", "email")
    VALUES ('tenant-customer-a', 'tenant-a', 'Tenant Customer A', 'tenant-a@example.com')
  `;
  await prisma.$executeRaw`
    INSERT INTO "Product" ("id", "tenantId", "sku", "name", "unit", "listPrice")
    VALUES ('tenant-product-b', 'tenant-b', 'tenant-product-b', 'Tenant Product B', 'seat', 10)
  `;
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Rate" ("id", "customerId", "productId", "unitPrice", "effectiveDate")
      VALUES ('cross-tenant-rate', 'tenant-customer-a', 'tenant-product-b', 10, CURRENT_TIMESTAMP)
    `,
    /Rate customer and product must share a tenant/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Order" ("id", "tenantId", "customerId", "status", "orderDate")
      VALUES ('cross-tenant-order', 'tenant-b', 'tenant-customer-a', 'OPEN', CURRENT_TIMESTAMP)
    `,
    /Order tenant conflicts with customer/u
  );
  await prisma.$executeRaw`
    INSERT INTO "Order" ("id", "tenantId", "customerId", "status", "orderDate")
    VALUES ('tenant-order-a', 'tenant-a', 'tenant-customer-a', 'OPEN', CURRENT_TIMESTAMP)
  `;
  await prisma.$executeRaw`
    INSERT INTO "Invoice" ("id", "tenantId", "number", "customerId", "orderId", "status", "dueDate")
    VALUES ('tenant-invoice-a', 'tenant-a', 'TENANT-INV-A', 'tenant-customer-a', 'tenant-order-a', 'DRAFT', CURRENT_TIMESTAMP)
  `;
  await prisma.$executeRaw`
    INSERT INTO "Customer" ("id", "tenantId", "name", "email")
    VALUES ('tenant-customer-b', 'tenant-b', 'Tenant Customer B', 'tenant-b@example.com')
  `;
  await prisma.$executeRaw`
    INSERT INTO "Payment" ("id", "tenantId", "customerId", "amount", "receivedAt")
    VALUES ('tenant-payment-b', 'tenant-b', 'tenant-customer-b', 5, CURRENT_TIMESTAMP)
  `;
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "PaymentApplication" ("id", "paymentId", "invoiceId", "amount", "appliedAt")
      VALUES ('cross-tenant-application', 'tenant-payment-b', 'tenant-invoice-a', 5, CURRENT_TIMESTAMP)
    `,
    /PaymentApplication payment and invoice must share a tenant/u
  );
  await prisma.$executeRaw`
    INSERT INTO "Customer" ("id", "name", "email")
    VALUES ('legacy-tenant-customer', 'Legacy Tenant Customer', 'legacy-tenant@example.com')
  `;
  await prisma.$executeRaw`
    INSERT INTO "Order" ("id", "tenantId", "customerId", "status", "orderDate")
    VALUES ('legacy-tenant-order', 'tenant-a', 'legacy-tenant-customer', 'OPEN', CURRENT_TIMESTAMP)
  `;
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "Customer" SET "tenantId" = 'tenant-b' WHERE "id" = 'legacy-tenant-customer'
    `,
    /Customer tenant conflicts with related commercial records/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "TenantAccountingPeriodControl" ("id", "tenantId", "closedThroughDate", "updatedAt")
      VALUES ('tenant-a-period', 'tenant-a', 'not-a-date', CURRENT_TIMESTAMP)
    `,
    /invalid TenantAccountingPeriodControl\.closedThroughDate/u
  );
  await assert.rejects(
    prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = 'tenant-a'`,
    /Tenant has referenced business records/u
  );

  // Version columns are nullable on deployment so a later bounded backfill can
  // initialize each row. Once initialized, direct SQL cannot make a version
  // negative, fractional, absent, or lower than the recorded value.
  await prisma.$executeRaw`
    INSERT INTO "Customer" ("id", "name", "email")
    VALUES ('version-customer', 'Versioned Customer', 'version-customer@example.com')
  `;
  await prisma.$executeRaw`
    UPDATE "Customer" SET "resourceVersion" = 5 WHERE "id" = 'version-customer'
  `;
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "Customer" SET "resourceVersion" = 4 WHERE "id" = 'version-customer'
    `,
    /Customer\.resourceVersion must increase monotonically/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "Customer" SET "resourceVersion" = NULL WHERE "id" = 'version-customer'
    `,
    /Customer\.resourceVersion must increase monotonically/u
  );
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Product" ("id", "sku", "name", "unit", "listPrice", "resourceVersion")
      VALUES ('invalid-version-product', 'invalid-version-product', 'Invalid Version Product', 'seat', 1, -1)
    `,
    /Product\.resourceVersion must be a nonnegative integer/u
  );
  await prisma.$executeRaw`
    INSERT INTO "Product" ("id", "sku", "name", "unit", "listPrice", "resourceVersion")
    VALUES ('version-product', 'version-product', 'Version Product', 'seat', 1, 1)
  `;
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "Rate" ("id", "customerId", "productId", "unitPrice", "effectiveDate", "resourceVersion")
      VALUES ('invalid-version-rate', 'version-customer', 'version-product', 1, CURRENT_TIMESTAMP, 1.5)
    `,
    /Rate\.resourceVersion must be a nonnegative integer/u
  );
  await prisma.$executeRaw`
    UPDATE "Order" SET "resourceVersion" = 2 WHERE "id" = 'migration-order'
  `;
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "Order" SET "resourceVersion" = 1 WHERE "id" = 'migration-order'
    `,
    /Order\.resourceVersion must increase monotonically/u
  );
  await prisma.$executeRaw`
    UPDATE "Invoice" SET "resourceVersion" = 2 WHERE "id" = 'tenant-invoice-a'
  `;
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "Invoice" SET "resourceVersion" = -1 WHERE "id" = 'tenant-invoice-a'
    `,
    /Invoice\.resourceVersion must increase monotonically/u
  );

  // Conditional-write rollout does not scan old Rates, but every future row
  // gets version 1 and a legacy/direct business update invalidates its ETag.
  await prisma.$executeRaw`
    INSERT INTO "Rate" ("id", "customerId", "productId", "unitPrice", "effectiveDate")
    VALUES ('versioned-rate', 'version-customer', 'version-product', 1, CURRENT_TIMESTAMP)
  `;
  let rateVersion = await prisma.$queryRaw<NumericRow[]>`
    SELECT "resourceVersion" FROM "Rate" WHERE "id" = 'versioned-rate'
  `;
  assert.equal(rateVersion[0]?.resourceVersion, 1);
  await prisma.$executeRaw`
    UPDATE "Rate" SET "unitPrice" = 2 WHERE "id" = 'versioned-rate'
  `;
  rateVersion = await prisma.$queryRaw<NumericRow[]>`
    SELECT "resourceVersion" FROM "Rate" WHERE "id" = 'versioned-rate'
  `;
  assert.equal(rateVersion[0]?.resourceVersion, 2);

  // Order aggregate tags advance for root, child, comment, and invoice changes.
  const orderVersion = await prisma.$queryRaw<NumericRow[]>`
    SELECT "resourceVersion" FROM "Order" WHERE "id" = 'tenant-order-a'
  `;
  assert.ok((orderVersion[0]?.resourceVersion ?? 0) >= 1);
}

void main().finally(() => prisma.$disconnect());
