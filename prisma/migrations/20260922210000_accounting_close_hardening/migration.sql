-- Follow-up guards for the singleton global accounting close. The original
-- foundation already validates dates and monotonicity; these guards refuse a
-- close or finalized invoice transition when date evidence is absent, and
-- prevent deleting the accounting fact.
CREATE TRIGGER "AccountingPeriodControl_delete_guard"
BEFORE DELETE ON "AccountingPeriodControl"
BEGIN
  SELECT RAISE(ABORT, 'accounting control cannot be deleted');
END;

CREATE TRIGGER "Invoice_finalized_accounting_date_required_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."status" IN ('POSTED', 'SENT', 'PAID') AND NEW."accountingDate" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a finalized invoice requires an accounting date');
END;

CREATE TRIGGER "Invoice_finalized_accounting_date_required_update_guard"
BEFORE UPDATE OF "status", "accountingDate" ON "Invoice"
WHEN NEW."status" IN ('POSTED', 'SENT', 'PAID')
  AND NEW."accountingDate" IS NULL
  AND (OLD."status" = 'DRAFT' OR NEW."accountingDate" IS NOT OLD."accountingDate")
BEGIN
  SELECT RAISE(ABORT, 'a finalized invoice requires an accounting date');
END;

CREATE TRIGGER "PaymentApplicationReversal_closed_period_insert_guard"
BEFORE INSERT ON "PaymentApplicationReversal"
WHEN EXISTS (
  SELECT 1
  FROM "PaymentApplication"
  JOIN "Invoice" ON "Invoice"."id" = "PaymentApplication"."invoiceId"
  JOIN "AccountingPeriodControl" ON "AccountingPeriodControl"."id" = 1
  WHERE "PaymentApplication"."id" = NEW."paymentApplicationId"
    AND "AccountingPeriodControl"."closedThroughDate" IS NOT NULL
    AND NEW."accountingDate" <= "AccountingPeriodControl"."closedThroughDate"
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reverse a payment application into a closed accounting period');
END;
