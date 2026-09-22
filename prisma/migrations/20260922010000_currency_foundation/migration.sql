-- Expand-only multi-currency foundation.
--
-- Currency remains nullable until the application dual-writes new records and a
-- bounded, resumable backfill has reconciled legacy rows. This migration never
-- scans or rewrites an existing table.

-- A catalog price, a negotiated rate, an order, an invoice, and a receipt each
-- need an explicit ISO 4217 currency. Order items inherit the order currency;
-- invoice lines inherit the invoice currency; payment applications will later
-- validate the payment and invoice currencies when application logic moves to
-- the ledger workflow.
ALTER TABLE "Product" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "Rate" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "Order" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "Payment" ADD COLUMN "currencyCode" TEXT;

-- SQLite has no domain type for ISO 4217. These guards deliberately validate
-- the stable storage contract (a nullable three-character uppercase code); the
-- application owns membership in the current ISO 4217 code list.
CREATE TRIGGER "Product_currency_code_insert_guard"
BEFORE INSERT ON "Product"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Product.currencyCode');
END;

CREATE TRIGGER "Product_currency_code_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Product"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Product.currencyCode');
END;

CREATE TRIGGER "Rate_currency_code_insert_guard"
BEFORE INSERT ON "Rate"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Rate.currencyCode');
END;

CREATE TRIGGER "Rate_currency_code_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Rate"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Rate.currencyCode');
END;

CREATE TRIGGER "Order_currency_code_insert_guard"
BEFORE INSERT ON "Order"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Order.currencyCode');
END;

CREATE TRIGGER "Order_currency_code_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Order"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Order.currencyCode');
END;

CREATE TRIGGER "Invoice_currency_code_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.currencyCode');
END;

CREATE TRIGGER "Invoice_currency_code_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.currencyCode');
END;

CREATE TRIGGER "Payment_currency_code_insert_guard"
BEFORE INSERT ON "Payment"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Payment.currencyCode');
END;

CREATE TRIGGER "Payment_currency_code_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Payment"
WHEN NEW."currencyCode" IS NOT NULL
  AND (length(NEW."currencyCode") <> 3 OR NEW."currencyCode" NOT GLOB '[A-Z][A-Z][A-Z]')
BEGIN
  SELECT RAISE(ABORT, 'invalid Payment.currencyCode');
END;

-- Cross-record currency guards permit a nullable rolling deploy, but reject a
-- mismatch as soon as both sides have been populated.
CREATE TRIGGER "Invoice_order_currency_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL
  AND (SELECT "currencyCode" FROM "Order" WHERE "id" = NEW."orderId") IS NOT NULL
  AND NEW."currencyCode" IS NOT (SELECT "currencyCode" FROM "Order" WHERE "id" = NEW."orderId")
BEGIN
  SELECT RAISE(ABORT, 'Invoice.currencyCode must match its order');
END;

CREATE TRIGGER "Invoice_order_currency_update_guard"
BEFORE UPDATE OF "currencyCode", "orderId" ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL
  AND (SELECT "currencyCode" FROM "Order" WHERE "id" = NEW."orderId") IS NOT NULL
  AND NEW."currencyCode" IS NOT (SELECT "currencyCode" FROM "Order" WHERE "id" = NEW."orderId")
BEGIN
  SELECT RAISE(ABORT, 'Invoice.currencyCode must match its order');
END;

CREATE TRIGGER "PaymentApplication_currency_insert_guard"
BEFORE INSERT ON "PaymentApplication"
WHEN (SELECT "currencyCode" FROM "Payment" WHERE "id" = NEW."paymentId") IS NOT NULL
  AND (SELECT "currencyCode" FROM "Invoice" WHERE "id" = NEW."invoiceId") IS NOT NULL
  AND (SELECT "currencyCode" FROM "Payment" WHERE "id" = NEW."paymentId")
    IS NOT (SELECT "currencyCode" FROM "Invoice" WHERE "id" = NEW."invoiceId")
BEGIN
  SELECT RAISE(ABORT, 'payment and invoice currencies must match');
END;

CREATE TRIGGER "PaymentApplication_currency_update_guard"
BEFORE UPDATE OF "paymentId", "invoiceId" ON "PaymentApplication"
WHEN (SELECT "currencyCode" FROM "Payment" WHERE "id" = NEW."paymentId") IS NOT NULL
  AND (SELECT "currencyCode" FROM "Invoice" WHERE "id" = NEW."invoiceId") IS NOT NULL
  AND (SELECT "currencyCode" FROM "Payment" WHERE "id" = NEW."paymentId")
    IS NOT (SELECT "currencyCode" FROM "Invoice" WHERE "id" = NEW."invoiceId")
BEGIN
  SELECT RAISE(ABORT, 'payment and invoice currencies must match');
END;

CREATE TRIGGER "Payment_currency_immutability_guard"
BEFORE UPDATE OF "currencyCode" ON "Payment"
WHEN OLD."currencyCode" IS NOT NULL
  AND NEW."currencyCode" IS NOT OLD."currencyCode"
BEGIN
  SELECT RAISE(ABORT, 'payment currency is immutable once captured');
END;

CREATE TRIGGER "Payment_currency_application_guard"
BEFORE UPDATE OF "currencyCode" ON "Payment"
WHEN NEW."currencyCode" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "PaymentApplication"
    JOIN "Invoice" ON "Invoice"."id" = "PaymentApplication"."invoiceId"
    WHERE "PaymentApplication"."paymentId" = OLD."id"
      AND "Invoice"."currencyCode" IS NOT NULL
      AND "Invoice"."currencyCode" IS NOT NEW."currencyCode"
  )
BEGIN
  SELECT RAISE(ABORT, 'payment currency must match applied invoices');
END;

CREATE TRIGGER "Invoice_currency_application_guard"
BEFORE UPDATE OF "currencyCode" ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "PaymentApplication"
    JOIN "Payment" ON "Payment"."id" = "PaymentApplication"."paymentId"
    WHERE "PaymentApplication"."invoiceId" = OLD."id"
      AND "Payment"."currencyCode" IS NOT NULL
      AND "Payment"."currencyCode" IS NOT NEW."currencyCode"
  )
BEGIN
  SELECT RAISE(ABORT, 'invoice currency must match applied payments');
END;

-- A legacy finalized row can receive its one backfilled currency value, but a
-- captured currency may never be changed. This complements the existing order
-- immutability trigger, which predates the currency field.
CREATE TRIGGER "Order_finalized_invoice_currency_immutability_guard"
BEFORE UPDATE OF "currencyCode" ON "Order"
WHEN OLD."currencyCode" IS NOT NULL
  AND NEW."currencyCode" IS NOT OLD."currencyCode"
  AND EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE "Invoice"."orderId" = OLD."id"
      AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  )
BEGIN
  SELECT RAISE(ABORT, 'orders with finalized invoices have immutable currency');
END;

-- A legacy finalized invoice can similarly be backfilled exactly once. Once a
-- posted currency is present, all later invoice lifecycle states preserve it.
CREATE TRIGGER "Invoice_posted_currency_immutability_guard"
BEFORE UPDATE OF "currencyCode" ON "Invoice"
WHEN OLD."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  AND OLD."currencyCode" IS NOT NULL
  AND NEW."currencyCode" IS NOT OLD."currencyCode"
BEGIN
  SELECT RAISE(ABORT, 'posted invoice currency is immutable');
END;
