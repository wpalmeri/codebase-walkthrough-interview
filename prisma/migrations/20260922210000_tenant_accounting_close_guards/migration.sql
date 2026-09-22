-- Tenant accounting-close trigger expansion.
--
-- This migration only installs row-local triggers. It does not create, scan,
-- rewrite, or reconcile business rows. SQLite writes serialize at database
-- scope, so rehearse a close against a production-sized copy during a
-- low-write window and measure trigger lookup latency/lock hold time.

-- A tenant may not create or advance its control until all of *that tenant's*
-- finalized invoices have an explicit accounting date.
CREATE TRIGGER "TenantAccountingPeriodControl_finalized_invoice_date_insert_guard"
BEFORE INSERT ON "TenantAccountingPeriodControl"
WHEN NEW."closedThroughDate" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Invoice"
    WHERE "tenantId" = NEW."tenantId"
      AND "status" IN ('POSTED', 'SENT', 'PAID')
      AND "accountingDate" IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'finalized tenant invoice accounting dates must be backfilled before closing');
END;

CREATE TRIGGER "TenantAccountingPeriodControl_finalized_invoice_date_update_guard"
BEFORE UPDATE OF "closedThroughDate" ON "TenantAccountingPeriodControl"
WHEN NEW."closedThroughDate" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Invoice"
    WHERE "tenantId" = NEW."tenantId"
      AND "status" IN ('POSTED', 'SENT', 'PAID')
      AND "accountingDate" IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'finalized tenant invoice accounting dates must be backfilled before closing');
END;

-- A close is an accounting fact. Corrections advance it; direct SQL cannot
-- erase it or transfer it to another tenant to reopen history.
CREATE TRIGGER "TenantAccountingPeriodControl_tenant_identity_guard"
BEFORE UPDATE OF "tenantId" ON "TenantAccountingPeriodControl"
WHEN NEW."tenantId" <> OLD."tenantId"
BEGIN
  SELECT RAISE(ABORT, 'tenant accounting control identity is immutable');
END;

CREATE TRIGGER "TenantAccountingPeriodControl_delete_guard"
BEFORE DELETE ON "TenantAccountingPeriodControl"
BEGIN
  SELECT RAISE(ABORT, 'tenant accounting control cannot be deleted');
END;

-- Finalized tenant invoices cannot enter or move into their own closed period.
CREATE TRIGGER "Invoice_tenant_closed_period_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."tenantId" IS NOT NULL
  AND NEW."status" IN ('POSTED', 'SENT', 'PAID')
  AND EXISTS (
    SELECT 1 FROM "TenantAccountingPeriodControl"
    WHERE "tenantId" = NEW."tenantId"
      AND "closedThroughDate" IS NOT NULL
      AND (NEW."accountingDate" IS NULL OR NEW."accountingDate" <= "closedThroughDate")
  )
BEGIN
  SELECT RAISE(ABORT, 'a finalized tenant invoice requires an open accounting date');
END;

CREATE TRIGGER "Invoice_tenant_closed_period_post_or_redate_guard"
BEFORE UPDATE OF "tenantId", "status", "accountingDate" ON "Invoice"
WHEN NEW."tenantId" IS NOT NULL
  AND NEW."status" IN ('POSTED', 'SENT', 'PAID')
  AND (
    NEW."tenantId" IS NOT OLD."tenantId"
    OR OLD."status" = 'DRAFT'
    OR NEW."accountingDate" IS NOT OLD."accountingDate"
  )
  AND EXISTS (
    SELECT 1 FROM "TenantAccountingPeriodControl"
    WHERE "tenantId" = NEW."tenantId"
      AND "closedThroughDate" IS NOT NULL
      AND (NEW."accountingDate" IS NULL OR NEW."accountingDate" <= "closedThroughDate")
  )
BEGIN
  SELECT RAISE(ABORT, 'a finalized tenant invoice requires an open accounting date');
END;

-- The tenant is derived from the immutable invoice linked to the application;
-- reversal rows do not carry caller-controlled tenant identity.
CREATE TRIGGER "PaymentApplicationReversal_tenant_closed_period_insert_guard"
BEFORE INSERT ON "PaymentApplicationReversal"
WHEN EXISTS (
  SELECT 1
  FROM "PaymentApplication"
  JOIN "Invoice" ON "Invoice"."id" = "PaymentApplication"."invoiceId"
  JOIN "TenantAccountingPeriodControl"
    ON "TenantAccountingPeriodControl"."tenantId" = "Invoice"."tenantId"
  WHERE "PaymentApplication"."id" = NEW."paymentApplicationId"
    AND "TenantAccountingPeriodControl"."closedThroughDate" IS NOT NULL
    AND NEW."accountingDate" <= "TenantAccountingPeriodControl"."closedThroughDate"
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reverse a tenant payment application into a closed accounting period');
END;
