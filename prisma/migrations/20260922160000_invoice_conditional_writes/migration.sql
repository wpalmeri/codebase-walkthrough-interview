-- Expand-only Invoice aggregate ETag invalidation. No scans or table rebuilds.
CREATE TRIGGER "Invoice_resource_version_initialize"
AFTER INSERT ON "Invoice" WHEN NEW."resourceVersion" IS NULL
BEGIN UPDATE "Invoice" SET "resourceVersion" = 1 WHERE "id" = NEW."id" AND "resourceVersion" IS NULL; END;
CREATE TRIGGER "Invoice_resource_version_business_update_bump"
AFTER UPDATE OF "number", "customerId", "orderId", "status", "issueDate", "dueDate", "total", "amountPaid", "totalDecimal", "amountPaidDecimal", "customerNameSnapshot", "customerEmailSnapshot", "billingAddressSnapshot", "postedAt", "accountingDate", "currencyCode" ON "Invoice"
WHEN NEW."resourceVersion" IS OLD."resourceVersion"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN OLD."resourceVersion" IS NULL THEN 1 ELSE OLD."resourceVersion" + 1 END WHERE "id" = NEW."id" AND "resourceVersion" IS OLD."resourceVersion"; END;
CREATE TRIGGER "InvoiceLine_invoice_version_insert_bump" AFTER INSERT ON "InvoiceLine"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = NEW."invoiceId"; END;
CREATE TRIGGER "InvoiceLine_invoice_version_update_bump" AFTER UPDATE ON "InvoiceLine"
BEGIN
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = OLD."invoiceId";
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE NEW."invoiceId" <> OLD."invoiceId" AND "id" = NEW."invoiceId";
END;
CREATE TRIGGER "InvoiceLine_invoice_version_delete_bump" AFTER DELETE ON "InvoiceLine"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = OLD."invoiceId"; END;
CREATE TRIGGER "PaymentApplication_invoice_version_insert_bump" AFTER INSERT ON "PaymentApplication"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = NEW."invoiceId"; END;
CREATE TRIGGER "PaymentApplication_invoice_version_update_bump" AFTER UPDATE ON "PaymentApplication"
BEGIN
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = OLD."invoiceId";
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE NEW."invoiceId" <> OLD."invoiceId" AND "id" = NEW."invoiceId";
END;
CREATE TRIGGER "PaymentApplication_invoice_version_delete_bump" AFTER DELETE ON "PaymentApplication"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = OLD."invoiceId"; END;
CREATE TRIGGER "PaymentApplicationReversal_invoice_version_insert_bump" AFTER INSERT ON "PaymentApplicationReversal"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = (SELECT "invoiceId" FROM "PaymentApplication" WHERE "id" = NEW."paymentApplicationId"); END;
CREATE TRIGGER "PaymentApplicationReversal_invoice_version_update_bump" AFTER UPDATE ON "PaymentApplicationReversal"
BEGIN
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = (SELECT "invoiceId" FROM "PaymentApplication" WHERE "id" = OLD."paymentApplicationId");
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE NEW."paymentApplicationId" <> OLD."paymentApplicationId" AND "id" = (SELECT "invoiceId" FROM "PaymentApplication" WHERE "id" = NEW."paymentApplicationId");
END;
CREATE TRIGGER "PaymentApplicationReversal_invoice_version_delete_bump" AFTER DELETE ON "PaymentApplicationReversal"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = (SELECT "invoiceId" FROM "PaymentApplication" WHERE "id" = OLD."paymentApplicationId"); END;
CREATE TRIGGER "Transmission_invoice_version_insert_bump" AFTER INSERT ON "Transmission"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = NEW."invoiceId"; END;
CREATE TRIGGER "Transmission_invoice_version_update_bump" AFTER UPDATE ON "Transmission"
BEGIN
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = OLD."invoiceId";
  UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE NEW."invoiceId" <> OLD."invoiceId" AND "id" = NEW."invoiceId";
END;
CREATE TRIGGER "Transmission_invoice_version_delete_bump" AFTER DELETE ON "Transmission"
BEGIN UPDATE "Invoice" SET "resourceVersion" = CASE WHEN "resourceVersion" IS NULL THEN 1 ELSE "resourceVersion" + 1 END WHERE "id" = OLD."invoiceId"; END;
