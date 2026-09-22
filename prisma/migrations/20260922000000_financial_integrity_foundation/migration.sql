-- Expand-only financial integrity migration.
--
-- The legacy REAL columns remain during the dual-write cutover. Removing them or
-- making the new columns NOT NULL requires a later contract migration after all
-- application instances read/write the decimal fields.

-- Decimal catalog and rate fields. SQLite records the declaration but does not
-- itself enforce DECIMAL precision/scale; application validation remains required.
ALTER TABLE "Product" ADD COLUMN "listPriceDecimal" DECIMAL(19,4);
ALTER TABLE "Rate" ADD COLUMN "unitPriceDecimal" DECIMAL(19,4);
ALTER TABLE "ComboDiscount" ADD COLUMN "percentOffDecimal" DECIMAL(7,4);

-- Immutable order-time product and pricing inputs, plus exact calculated values.
ALTER TABLE "OrderItem" ADD COLUMN "productSkuSnapshot" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "productNameSnapshot" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "productUnitSnapshot" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "quantityDecimal" DECIMAL(19,6);
ALTER TABLE "OrderItem" ADD COLUMN "baseUnitPriceDecimal" DECIMAL(19,4);
ALTER TABLE "OrderItem" ADD COLUMN "effectiveUnitPriceDecimal" DECIMAL(19,4);
ALTER TABLE "OrderItem" ADD COLUMN "pricingSnapshot" JSONB;
ALTER TABLE "OrderItem" ADD COLUMN "pricingCapturedAt" DATETIME;
ALTER TABLE "OrderItem" ADD COLUMN "snapshotVersion" INTEGER;

-- Exact invoice, receipt, and allocation values.
ALTER TABLE "Invoice" ADD COLUMN "totalDecimal" DECIMAL(19,4);
ALTER TABLE "Invoice" ADD COLUMN "amountPaidDecimal" DECIMAL(19,4);
ALTER TABLE "Invoice" ADD COLUMN "customerNameSnapshot" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "customerEmailSnapshot" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billingAddressSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "productSkuSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "productUnitSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "quantityDecimal" DECIMAL(19,6);
ALTER TABLE "InvoiceLine" ADD COLUMN "unitPriceDecimal" DECIMAL(19,4);
ALTER TABLE "InvoiceLine" ADD COLUMN "amountDecimal" DECIMAL(19,4);
ALTER TABLE "Payment" ADD COLUMN "amountDecimal" DECIMAL(19,4);
ALTER TABLE "PaymentApplication" ADD COLUMN "amountDecimal" DECIMAL(19,4);

-- Existing rows are intentionally left null. Backfill is a separately monitored,
-- bounded-batch application operation so this deploy migration does not hold a
-- database-wide SQLite writer lock for a table scan.

-- SQLite-backed Prisma schemas cannot declare enums. These triggers provide
-- database-level value constraints without rebuilding or replacing live tables.
CREATE TRIGGER "Order_status_insert_guard"
BEFORE INSERT ON "Order"
WHEN NEW."status" NOT IN ('OPEN', 'INVOICED', 'CLOSED')
BEGIN
  SELECT RAISE(ABORT, 'invalid Order.status');
END;

CREATE TRIGGER "Order_status_update_guard"
BEFORE UPDATE OF "status" ON "Order"
WHEN NEW."status" NOT IN ('OPEN', 'INVOICED', 'CLOSED')
BEGIN
  SELECT RAISE(ABORT, 'invalid Order.status');
END;

CREATE TRIGGER "Order_status_transition_guard"
BEFORE UPDATE OF "status" ON "Order"
WHEN NOT (
  NEW."status" = OLD."status"
  OR (OLD."status" = 'OPEN' AND NEW."status" = 'INVOICED')
  OR (OLD."status" = 'INVOICED' AND NEW."status" = 'CLOSED')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Order.status transition');
END;

CREATE TRIGGER "Invoice_status_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."status" NOT IN ('DRAFT', 'POSTED', 'SENT', 'PAID', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.status');
END;

CREATE TRIGGER "Invoice_status_update_guard"
BEFORE UPDATE OF "status" ON "Invoice"
WHEN NEW."status" NOT IN ('DRAFT', 'POSTED', 'SENT', 'PAID', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.status');
END;

CREATE TRIGGER "Invoice_status_transition_guard"
BEFORE UPDATE OF "status" ON "Invoice"
WHEN NOT (
  NEW."status" = OLD."status"
  OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('POSTED', 'VOID'))
  OR (OLD."status" = 'POSTED' AND NEW."status" IN ('SENT', 'PAID'))
  OR (OLD."status" = 'SENT' AND NEW."status" = 'PAID')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Invoice.status transition');
END;

CREATE TRIGGER "Transmission_method_status_insert_guard"
BEFORE INSERT ON "Transmission"
WHEN
  NEW."method" NOT IN ('EMAIL', 'PORTAL', 'API')
  OR (NEW."method" = 'EMAIL' AND NEW."status" NOT IN ('SENT', 'FAILED'))
  OR (NEW."method" = 'PORTAL' AND NEW."status" NOT IN ('QUEUED', 'UPLOADING', 'DELIVERED', 'FAILED'))
  OR (NEW."method" = 'API' AND NEW."status" NOT IN ('ACCEPTED', 'FAILED'))
BEGIN
  SELECT RAISE(ABORT, 'invalid Transmission method/status');
END;

CREATE TRIGGER "Transmission_method_status_update_guard"
BEFORE UPDATE OF "method", "status" ON "Transmission"
WHEN
  NEW."method" NOT IN ('EMAIL', 'PORTAL', 'API')
  OR (NEW."method" = 'EMAIL' AND NEW."status" NOT IN ('SENT', 'FAILED'))
  OR (NEW."method" = 'PORTAL' AND NEW."status" NOT IN ('QUEUED', 'UPLOADING', 'DELIVERED', 'FAILED'))
  OR (NEW."method" = 'API' AND NEW."status" NOT IN ('ACCEPTED', 'FAILED'))
BEGIN
  SELECT RAISE(ABORT, 'invalid Transmission method/status');
END;

-- Product and pricing inputs become write-once snapshots. Exact quantities and
-- calculated prices may still change while an order is legitimately edited.
CREATE TRIGGER "OrderItem_snapshot_immutability_guard"
BEFORE UPDATE ON "OrderItem"
WHEN
  (OLD."productSkuSnapshot" IS NOT NULL AND NEW."productSkuSnapshot" IS NOT OLD."productSkuSnapshot")
  OR (OLD."productNameSnapshot" IS NOT NULL AND NEW."productNameSnapshot" IS NOT OLD."productNameSnapshot")
  OR (OLD."productUnitSnapshot" IS NOT NULL AND NEW."productUnitSnapshot" IS NOT OLD."productUnitSnapshot")
  OR (OLD."baseUnitPriceDecimal" IS NOT NULL AND NEW."baseUnitPriceDecimal" IS NOT OLD."baseUnitPriceDecimal")
  OR (OLD."pricingSnapshot" IS NOT NULL AND NEW."pricingSnapshot" IS NOT OLD."pricingSnapshot")
  OR (OLD."pricingCapturedAt" IS NOT NULL AND NEW."pricingCapturedAt" IS NOT OLD."pricingCapturedAt")
  OR (OLD."snapshotVersion" IS NOT NULL AND NEW."snapshotVersion" IS NOT OLD."snapshotVersion")
BEGIN
  SELECT RAISE(ABORT, 'OrderItem pricing snapshot is immutable');
END;

-- A finalized invoice freezes the commercial order that produced it. Comments
-- intentionally remain append-only collaboration metadata and are not blocked.
CREATE TRIGGER "Order_finalized_invoice_update_guard"
BEFORE UPDATE ON "Order"
WHEN
  EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE "Invoice"."orderId" = OLD."id"
      AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  )
  AND (
    NEW."id" IS NOT OLD."id"
    OR NEW."reference" IS NOT OLD."reference"
    OR NEW."customerId" IS NOT OLD."customerId"
    OR NEW."orderDate" IS NOT OLD."orderDate"
    OR NEW."shipTo" IS NOT OLD."shipTo"
    OR NEW."notes" IS NOT OLD."notes"
  )
BEGIN
  SELECT RAISE(ABORT, 'orders with finalized invoices are immutable');
END;

CREATE TRIGGER "Order_finalized_invoice_delete_guard"
BEFORE DELETE ON "Order"
WHEN EXISTS (
  SELECT 1
  FROM "Invoice"
  WHERE "Invoice"."orderId" = OLD."id"
    AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
)
BEGIN
  SELECT RAISE(ABORT, 'orders with finalized invoices cannot be deleted');
END;

CREATE TRIGGER "OrderItem_finalized_invoice_insert_guard"
BEFORE INSERT ON "OrderItem"
WHEN EXISTS (
  SELECT 1
  FROM "Invoice"
  WHERE "Invoice"."orderId" = NEW."orderId"
    AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
)
BEGIN
  SELECT RAISE(ABORT, 'items on orders with finalized invoices are immutable');
END;

CREATE TRIGGER "OrderItem_finalized_invoice_update_guard"
BEFORE UPDATE ON "OrderItem"
WHEN
  EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE "Invoice"."orderId" = OLD."orderId"
      AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  )
  OR EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE "Invoice"."orderId" = NEW."orderId"
      AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  )
BEGIN
  SELECT RAISE(ABORT, 'items on orders with finalized invoices are immutable');
END;

CREATE TRIGGER "OrderItem_finalized_invoice_delete_guard"
BEFORE DELETE ON "OrderItem"
WHEN EXISTS (
  SELECT 1
  FROM "Invoice"
  WHERE "Invoice"."orderId" = OLD."orderId"
    AND "Invoice"."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
)
BEGIN
  SELECT RAISE(ABORT, 'items on orders with finalized invoices are immutable');
END;

-- Draft invoice lines remain editable. Once an invoice is posted, sent, or paid,
-- its lines and financial identity are immutable at the database boundary.
CREATE TRIGGER "InvoiceLine_posted_insert_guard"
BEFORE INSERT ON "InvoiceLine"
WHEN (SELECT "status" FROM "Invoice" WHERE "id" = NEW."invoiceId") <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'posted invoice lines are immutable');
END;

CREATE TRIGGER "InvoiceLine_posted_update_guard"
BEFORE UPDATE ON "InvoiceLine"
WHEN
  (
    (SELECT "status" FROM "Invoice" WHERE "id" = OLD."invoiceId") <> 'DRAFT'
    OR (SELECT "status" FROM "Invoice" WHERE "id" = NEW."invoiceId") <> 'DRAFT'
  )
  AND (
    NEW."invoiceId" IS NOT OLD."invoiceId"
    OR NEW."description" IS NOT OLD."description"
    OR NEW."quantity" IS NOT OLD."quantity"
    OR NEW."unitPrice" IS NOT OLD."unitPrice"
    OR NEW."amount" IS NOT OLD."amount"
    OR (OLD."productSkuSnapshot" IS NOT NULL AND NEW."productSkuSnapshot" IS NOT OLD."productSkuSnapshot")
    OR (OLD."productUnitSnapshot" IS NOT NULL AND NEW."productUnitSnapshot" IS NOT OLD."productUnitSnapshot")
    OR (OLD."quantityDecimal" IS NOT NULL AND NEW."quantityDecimal" IS NOT OLD."quantityDecimal")
    OR (OLD."unitPriceDecimal" IS NOT NULL AND NEW."unitPriceDecimal" IS NOT OLD."unitPriceDecimal")
    OR (OLD."amountDecimal" IS NOT NULL AND NEW."amountDecimal" IS NOT OLD."amountDecimal")
  )
BEGIN
  SELECT RAISE(ABORT, 'posted invoice lines are immutable');
END;

CREATE TRIGGER "InvoiceLine_posted_delete_guard"
BEFORE DELETE ON "InvoiceLine"
WHEN (SELECT "status" FROM "Invoice" WHERE "id" = OLD."invoiceId") <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'posted invoice lines are immutable');
END;

CREATE TRIGGER "Invoice_posted_financial_immutability_guard"
BEFORE UPDATE ON "Invoice"
WHEN
  OLD."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
  AND (
    NEW."number" IS NOT OLD."number"
    OR NEW."customerId" IS NOT OLD."customerId"
    OR NEW."orderId" IS NOT OLD."orderId"
    OR NEW."issueDate" IS NOT OLD."issueDate"
    OR NEW."dueDate" IS NOT OLD."dueDate"
    OR NEW."total" IS NOT OLD."total"
    OR (OLD."totalDecimal" IS NOT NULL AND NEW."totalDecimal" IS NOT OLD."totalDecimal")
    OR (OLD."customerNameSnapshot" IS NOT NULL AND NEW."customerNameSnapshot" IS NOT OLD."customerNameSnapshot")
    OR (OLD."customerEmailSnapshot" IS NOT NULL AND NEW."customerEmailSnapshot" IS NOT OLD."customerEmailSnapshot")
    OR (OLD."billingAddressSnapshot" IS NOT NULL AND NEW."billingAddressSnapshot" IS NOT OLD."billingAddressSnapshot")
    OR NEW."postedAt" IS NOT OLD."postedAt"
  )
BEGIN
  SELECT RAISE(ABORT, 'posted invoice financial fields are immutable');
END;

CREATE TRIGGER "Invoice_posted_delete_guard"
BEFORE DELETE ON "Invoice"
WHEN OLD."status" IN ('POSTED', 'SENT', 'PAID', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'posted invoices cannot be deleted');
END;
