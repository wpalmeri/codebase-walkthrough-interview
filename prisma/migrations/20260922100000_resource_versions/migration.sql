-- Expand-only resource-version foundation.
--
-- These nullable columns deliberately have neither defaults nor a data
-- backfill: adding them is metadata-only for existing SQLite tables. Future
-- conditional writes will predicate on the primary key and this version, so a
-- separate version-only index would not improve the lookup and is omitted.

ALTER TABLE "Customer" ADD COLUMN "resourceVersion" INTEGER;
ALTER TABLE "Product" ADD COLUMN "resourceVersion" INTEGER;
ALTER TABLE "Rate" ADD COLUMN "resourceVersion" INTEGER;
ALTER TABLE "ComboDiscount" ADD COLUMN "resourceVersion" INTEGER;
ALTER TABLE "Order" ADD COLUMN "resourceVersion" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "resourceVersion" INTEGER;

-- SQLite INTEGER affinity still accepts values such as 1.5 unless a trigger
-- checks the stored type. A null legacy value may be initialized once; after
-- that the version cannot be cleared or moved backwards. We intentionally do
-- not require a particular increment here so endpoints can introduce
-- compare-and-swap behavior independently without breaking legacy writers.
CREATE TRIGGER "Customer_resource_version_insert_guard"
BEFORE INSERT ON "Customer"
WHEN NEW."resourceVersion" IS NOT NULL
  AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0)
BEGIN
  SELECT RAISE(ABORT, 'Customer.resourceVersion must be a nonnegative integer');
END;

CREATE TRIGGER "Customer_resource_version_update_guard"
BEFORE UPDATE OF "resourceVersion" ON "Customer"
WHEN (NEW."resourceVersion" IS NOT NULL
      AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0))
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" IS NULL)
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" < OLD."resourceVersion")
BEGIN
  SELECT RAISE(ABORT, 'Customer.resourceVersion must increase monotonically');
END;

CREATE TRIGGER "Product_resource_version_insert_guard"
BEFORE INSERT ON "Product"
WHEN NEW."resourceVersion" IS NOT NULL
  AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0)
BEGIN
  SELECT RAISE(ABORT, 'Product.resourceVersion must be a nonnegative integer');
END;

CREATE TRIGGER "Product_resource_version_update_guard"
BEFORE UPDATE OF "resourceVersion" ON "Product"
WHEN (NEW."resourceVersion" IS NOT NULL
      AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0))
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" IS NULL)
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" < OLD."resourceVersion")
BEGIN
  SELECT RAISE(ABORT, 'Product.resourceVersion must increase monotonically');
END;

CREATE TRIGGER "Rate_resource_version_insert_guard"
BEFORE INSERT ON "Rate"
WHEN NEW."resourceVersion" IS NOT NULL
  AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0)
BEGIN
  SELECT RAISE(ABORT, 'Rate.resourceVersion must be a nonnegative integer');
END;

CREATE TRIGGER "Rate_resource_version_update_guard"
BEFORE UPDATE OF "resourceVersion" ON "Rate"
WHEN (NEW."resourceVersion" IS NOT NULL
      AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0))
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" IS NULL)
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" < OLD."resourceVersion")
BEGIN
  SELECT RAISE(ABORT, 'Rate.resourceVersion must increase monotonically');
END;

CREATE TRIGGER "ComboDiscount_resource_version_insert_guard"
BEFORE INSERT ON "ComboDiscount"
WHEN NEW."resourceVersion" IS NOT NULL
  AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0)
BEGIN
  SELECT RAISE(ABORT, 'ComboDiscount.resourceVersion must be a nonnegative integer');
END;

CREATE TRIGGER "ComboDiscount_resource_version_update_guard"
BEFORE UPDATE OF "resourceVersion" ON "ComboDiscount"
WHEN (NEW."resourceVersion" IS NOT NULL
      AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0))
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" IS NULL)
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" < OLD."resourceVersion")
BEGIN
  SELECT RAISE(ABORT, 'ComboDiscount.resourceVersion must increase monotonically');
END;

CREATE TRIGGER "Order_resource_version_insert_guard"
BEFORE INSERT ON "Order"
WHEN NEW."resourceVersion" IS NOT NULL
  AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0)
BEGIN
  SELECT RAISE(ABORT, 'Order.resourceVersion must be a nonnegative integer');
END;

CREATE TRIGGER "Order_resource_version_update_guard"
BEFORE UPDATE OF "resourceVersion" ON "Order"
WHEN (NEW."resourceVersion" IS NOT NULL
      AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0))
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" IS NULL)
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" < OLD."resourceVersion")
BEGIN
  SELECT RAISE(ABORT, 'Order.resourceVersion must increase monotonically');
END;

CREATE TRIGGER "Invoice_resource_version_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."resourceVersion" IS NOT NULL
  AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0)
BEGIN
  SELECT RAISE(ABORT, 'Invoice.resourceVersion must be a nonnegative integer');
END;

CREATE TRIGGER "Invoice_resource_version_update_guard"
BEFORE UPDATE OF "resourceVersion" ON "Invoice"
WHEN (NEW."resourceVersion" IS NOT NULL
      AND (typeof(NEW."resourceVersion") <> 'integer' OR NEW."resourceVersion" < 0))
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" IS NULL)
  OR (OLD."resourceVersion" IS NOT NULL AND NEW."resourceVersion" < OLD."resourceVersion")
BEGIN
  SELECT RAISE(ABORT, 'Invoice.resourceVersion must increase monotonically');
END;
