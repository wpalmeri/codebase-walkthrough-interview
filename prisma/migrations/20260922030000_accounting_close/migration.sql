-- Expand-only accounting-close foundation.
--
-- `accountingDate` is deliberately a nullable ISO calendar date rather than a
-- timestamp. Existing invoice instants can be mapped to UTC dates by the
-- application during the bounded backfill; this migration itself never scans
-- or rewrites Invoice.
ALTER TABLE "Invoice" ADD COLUMN "accountingDate" TEXT;

-- One explicit control row contains the inclusive close boundary. A missing
-- row or null close date intentionally means no periods are closed yet.
CREATE TABLE "AccountingPeriodControl" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "closedThroughDate" TEXT,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountingPeriodControl_singleton" CHECK ("id" = 1)
);

-- SQLite has no native DATE type. Keep the compact YYYY-MM-DD storage shape
-- at the database boundary, including month/leap-day normalization; Zod owns
-- the equivalent API/domain contract. Null remains legal during rollout.
CREATE TRIGGER "Invoice_accounting_date_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."accountingDate" IS NOT NULL
  AND (
    length(NEW."accountingDate") <> 10
    OR NEW."accountingDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR strftime('%Y-%m-%d', NEW."accountingDate") IS NOT NEW."accountingDate"
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.accountingDate');
END;

CREATE TRIGGER "Invoice_accounting_date_update_guard"
BEFORE UPDATE OF "accountingDate" ON "Invoice"
WHEN NEW."accountingDate" IS NOT NULL
  AND (
    length(NEW."accountingDate") <> 10
    OR NEW."accountingDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR strftime('%Y-%m-%d', NEW."accountingDate") IS NOT NEW."accountingDate"
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.accountingDate');
END;

CREATE TRIGGER "AccountingPeriodControl_closed_through_insert_guard"
BEFORE INSERT ON "AccountingPeriodControl"
WHEN NEW."closedThroughDate" IS NOT NULL
  AND (
    length(NEW."closedThroughDate") <> 10
    OR NEW."closedThroughDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR strftime('%Y-%m-%d', NEW."closedThroughDate") IS NOT NEW."closedThroughDate"
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid AccountingPeriodControl.closedThroughDate');
END;

CREATE TRIGGER "AccountingPeriodControl_backfill_insert_guard"
BEFORE INSERT ON "AccountingPeriodControl"
WHEN NEW."closedThroughDate" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE "status" IN ('POSTED', 'SENT', 'PAID')
      AND "accountingDate" IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'finalized invoice accounting dates must be backfilled before closing');
END;

-- Close advancement is one-way. Correcting a close requires an auditable
-- administrative procedure rather than silently reopening accounting periods.
CREATE TRIGGER "AccountingPeriodControl_closed_through_update_guard"
BEFORE UPDATE OF "closedThroughDate" ON "AccountingPeriodControl"
WHEN
  (NEW."closedThroughDate" IS NOT NULL AND (
    length(NEW."closedThroughDate") <> 10
    OR NEW."closedThroughDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR strftime('%Y-%m-%d', NEW."closedThroughDate") IS NOT NEW."closedThroughDate"
  ))
  OR (OLD."closedThroughDate" IS NOT NULL AND (
    NEW."closedThroughDate" IS NULL
    OR NEW."closedThroughDate" < OLD."closedThroughDate"
  ))
BEGIN
  SELECT RAISE(ABORT, 'AccountingPeriodControl.closedThroughDate cannot move backward');
END;

CREATE TRIGGER "AccountingPeriodControl_backfill_update_guard"
BEFORE UPDATE OF "closedThroughDate" ON "AccountingPeriodControl"
WHEN NEW."closedThroughDate" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE "status" IN ('POSTED', 'SENT', 'PAID')
      AND "accountingDate" IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'finalized invoice accounting dates must be backfilled before closing');
END;

-- A finalized invoice may neither be posted nor assigned/reassigned an
-- accounting date on or before the inclusive close boundary. Existing null
-- dates remain writable only while their target period is open.
CREATE TRIGGER "Invoice_closed_period_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."status" IN ('POSTED', 'SENT', 'PAID')
  AND NEW."accountingDate" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "AccountingPeriodControl"
    WHERE "id" = 1
      AND "closedThroughDate" IS NOT NULL
      AND NEW."accountingDate" <= "closedThroughDate"
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot post an invoice into a closed accounting period');
END;

CREATE TRIGGER "Invoice_closed_period_post_or_redate_guard"
BEFORE UPDATE OF "status", "accountingDate" ON "Invoice"
WHEN NEW."status" IN ('POSTED', 'SENT', 'PAID')
  AND NEW."accountingDate" IS NOT NULL
  AND (OLD."status" = 'DRAFT' OR NEW."accountingDate" IS NOT OLD."accountingDate")
  AND EXISTS (
    SELECT 1
    FROM "AccountingPeriodControl"
    WHERE "id" = 1
      AND "closedThroughDate" IS NOT NULL
      AND NEW."accountingDate" <= "closedThroughDate"
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot post or redate an invoice into a closed accounting period');
END;

-- A staged finalized-row backfill may populate one null accounting date. Once
-- present, the accounting identity is immutable just like the posted total.
CREATE TRIGGER "Invoice_finalized_accounting_date_immutability_guard"
BEFORE UPDATE OF "accountingDate" ON "Invoice"
WHEN OLD."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  AND OLD."accountingDate" IS NOT NULL
  AND NEW."accountingDate" IS NOT OLD."accountingDate"
BEGIN
  SELECT RAISE(ABORT, 'finalized invoice accounting date is immutable');
END;
