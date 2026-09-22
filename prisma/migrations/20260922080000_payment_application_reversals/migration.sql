-- Additive, append-only payment-application reversals.
--
-- This creates a new empty ledger table and metadata-only triggers/indexes. It
-- does not scan, rewrite, or lock existing financial tables for a backfill.
CREATE TABLE "PaymentApplicationReversal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentApplicationId" TEXT NOT NULL,
  "amountDecimal" DECIMAL(19,4) NOT NULL,
  "reason" TEXT NOT NULL,
  "accountingDate" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentApplicationReversal_paymentApplicationId_fkey"
    FOREIGN KEY ("paymentApplicationId") REFERENCES "PaymentApplication" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PaymentApplicationReversal_paymentApplicationId_idx"
ON "PaymentApplicationReversal"("paymentApplicationId");

CREATE INDEX "PaymentApplicationReversal_accountingDate_idx"
ON "PaymentApplicationReversal"("accountingDate");

-- New reversals require an exact positive amount and bounded audit metadata.
-- SQLite applies NUMERIC affinity to DECIMAL, so the API additionally requires
-- canonical fixed-scale strings before Prisma writes this value.
CREATE TRIGGER "PaymentApplicationReversal_input_guard"
BEFORE INSERT ON "PaymentApplicationReversal"
WHEN
  NEW."amountDecimal" <= 0
  OR NEW."amountDecimal" > 999999999999999.9999
  OR round(NEW."amountDecimal", 4) <> NEW."amountDecimal"
  OR length(trim(NEW."reason")) = 0
  OR length(NEW."reason") > 1000
  OR NEW."actor" <> 'system:meridian-api'
  OR length(NEW."accountingDate") <> 10
  OR NEW."accountingDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR strftime('%Y-%m-%d', NEW."accountingDate") IS NOT NEW."accountingDate"
BEGIN
  SELECT RAISE(ABORT, 'invalid PaymentApplicationReversal input');
END;

-- A legacy application must be fully backfilled before it can be reversed.
-- The same guard rejects pre-existing corrupt customer/currency relationships.
CREATE TRIGGER "PaymentApplicationReversal_commercial_identity_guard"
BEFORE INSERT ON "PaymentApplicationReversal"
WHEN NOT EXISTS (
  SELECT 1
  FROM "PaymentApplication" AS application
  JOIN "Payment" AS payment ON payment."id" = application."paymentId"
  JOIN "Invoice" AS invoice ON invoice."id" = application."invoiceId"
  WHERE application."id" = NEW."paymentApplicationId"
    AND application."amountDecimal" IS NOT NULL
    AND payment."currencyCode" IS NOT NULL
    AND invoice."currencyCode" IS NOT NULL
    AND payment."customerId" = invoice."customerId"
    AND payment."currencyCode" = invoice."currencyCode"
)
BEGIN
  SELECT RAISE(ABORT, 'payment application reversal requires exact matching commercial facts');
END;

-- This protects the invariant even when concurrent writers bypass the API CAS.
CREATE TRIGGER "PaymentApplicationReversal_amount_guard"
BEFORE INSERT ON "PaymentApplicationReversal"
WHEN (
  COALESCE((
    SELECT sum(reversal."amountDecimal")
    FROM "PaymentApplicationReversal" AS reversal
    WHERE reversal."paymentApplicationId" = NEW."paymentApplicationId"
  ), 0) + NEW."amountDecimal"
) > (
  SELECT application."amountDecimal"
  FROM "PaymentApplication" AS application
  WHERE application."id" = NEW."paymentApplicationId"
)
BEGIN
  SELECT RAISE(ABORT, 'payment application reversal exceeds original application');
END;

CREATE TRIGGER "PaymentApplicationReversal_closed_period_guard"
BEFORE INSERT ON "PaymentApplicationReversal"
WHEN EXISTS (
  SELECT 1
  FROM "AccountingPeriodControl"
  WHERE "id" = 1
    AND "closedThroughDate" IS NOT NULL
    AND NEW."accountingDate" <= "closedThroughDate"
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reverse a payment application into a closed accounting period');
END;

CREATE TRIGGER "PaymentApplicationReversal_append_only_update_guard"
BEFORE UPDATE ON "PaymentApplicationReversal"
BEGIN
  SELECT RAISE(ABORT, 'PaymentApplicationReversal is append-only and cannot be updated');
END;

CREATE TRIGGER "PaymentApplicationReversal_append_only_delete_guard"
BEFORE DELETE ON "PaymentApplicationReversal"
BEGIN
  SELECT RAISE(ABORT, 'PaymentApplicationReversal is append-only and cannot be deleted');
END;

-- Reversal is the only ordinary workflow that can move a PAID invoice back to
-- an open receivable state. Replacing this trigger is metadata-only.
DROP TRIGGER "Invoice_status_transition_guard";

CREATE TRIGGER "Invoice_status_transition_guard"
BEFORE UPDATE OF "status" ON "Invoice"
WHEN NOT (
  NEW."status" = OLD."status"
  OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('POSTED', 'VOID'))
  OR (OLD."status" = 'POSTED' AND NEW."status" IN ('SENT', 'PAID'))
  OR (OLD."status" = 'SENT' AND NEW."status" = 'PAID')
  OR (
    OLD."status" = 'PAID'
    AND NEW."status" IN ('POSTED', 'SENT')
    AND EXISTS (
      SELECT 1
      FROM "PaymentApplication" AS application
      JOIN "PaymentApplicationReversal" AS reversal
        ON reversal."paymentApplicationId" = application."id"
      WHERE application."invoiceId" = OLD."id"
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.status transition');
END;

-- Never infer SENT from the old PAID status. Only concrete successful provider
-- evidence can restore SENT; otherwise the invoice returns to POSTED.
CREATE TRIGGER "Invoice_reversal_status_evidence_guard"
BEFORE UPDATE OF "status", "amountPaid", "amountPaidDecimal" ON "Invoice"
WHEN EXISTS (
    SELECT 1
    FROM "PaymentApplication" AS application
    JOIN "PaymentApplicationReversal" AS reversal
      ON reversal."paymentApplicationId" = application."id"
    WHERE application."invoiceId" = OLD."id"
  )
  AND (
    NEW."totalDecimal" IS NULL
    OR NEW."amountPaidDecimal" IS NULL
    OR EXISTS (
      SELECT 1
      FROM "PaymentApplication"
      WHERE "invoiceId" = OLD."id"
        AND "amountDecimal" IS NULL
    )
    OR NEW."amountPaidDecimal" <> (
      COALESCE((
        SELECT sum(application."amountDecimal")
        FROM "PaymentApplication" AS application
        WHERE application."invoiceId" = OLD."id"
      ), 0)
      - COALESCE((
        SELECT sum(reversal."amountDecimal")
        FROM "PaymentApplicationReversal" AS reversal
        JOIN "PaymentApplication" AS application
          ON application."id" = reversal."paymentApplicationId"
        WHERE application."invoiceId" = OLD."id"
      ), 0)
    )
    OR abs(NEW."amountPaid" - NEW."amountPaidDecimal") > 0.0000001
    OR NEW."status" <> CASE
      WHEN NEW."amountPaidDecimal" = NEW."totalDecimal" THEN 'PAID'
      WHEN EXISTS (
        SELECT 1
        FROM "Transmission"
        WHERE "invoiceId" = OLD."id"
          AND (
            ("method" = 'EMAIL' AND "status" = 'SENT')
            OR ("method" = 'PORTAL' AND "status" = 'DELIVERED')
            OR ("method" = 'API' AND "status" = 'ACCEPTED')
          )
      ) THEN 'SENT'
      ELSE 'POSTED'
    END
  )
BEGIN
  SELECT RAISE(ABORT, 'payment reversal invoice status lacks matching delivery evidence');
END;
