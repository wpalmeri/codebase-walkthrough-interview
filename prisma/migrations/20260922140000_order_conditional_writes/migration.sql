-- Expand-only Order conditional-write support.
--
-- No table is rebuilt, scanned, or backfilled. SQLite evaluates each trigger
-- only for the row being written; deploy during a low-write window because DDL
-- and the small parent-version bumps serialize writers.

-- New orders acquire a concrete version without changing historical null rows.
CREATE TRIGGER "Order_resource_version_initialize"
AFTER INSERT ON "Order"
WHEN NEW."resourceVersion" IS NULL
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = 1
  WHERE "id" = NEW."id" AND "resourceVersion" IS NULL;
END;

-- Direct/legacy root writes invalidate an Order representation. A conditional
-- API write updates resourceVersion itself and therefore does not match this
-- business-column trigger.
CREATE TRIGGER "Order_resource_version_business_update_bump"
AFTER UPDATE OF
  "reference", "customerId", "orderDate", "status", "shipTo", "notes", "currencyCode"
ON "Order"
WHEN NEW."resourceVersion" IS OLD."resourceVersion"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN OLD."resourceVersion" IS NULL THEN 1
    ELSE OLD."resourceVersion" + 1
  END
  WHERE "id" = NEW."id" AND "resourceVersion" IS OLD."resourceVersion";
END;

-- Item snapshots and comments are serialized in Order responses. Bump their
-- parent for every aggregate membership or representation change.
CREATE TRIGGER "OrderItem_order_version_insert_bump"
AFTER INSERT ON "OrderItem"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = NEW."orderId";
END;

CREATE TRIGGER "OrderItem_order_version_update_bump"
AFTER UPDATE OF
  "orderId", "productId", "rateId", "quantity", "unitPrice",
  "productSkuSnapshot", "productNameSnapshot", "productUnitSnapshot",
  "quantityDecimal", "baseUnitPriceDecimal", "effectiveUnitPriceDecimal",
  "amountDecimal", "pricingSnapshot", "pricingCapturedAt", "snapshotVersion"
ON "OrderItem"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = OLD."orderId";
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE NEW."orderId" <> OLD."orderId" AND "id" = NEW."orderId";
END;

CREATE TRIGGER "OrderItem_order_version_delete_bump"
AFTER DELETE ON "OrderItem"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = OLD."orderId";
END;

CREATE TRIGGER "OrderComment_order_version_insert_bump"
AFTER INSERT ON "OrderComment"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = NEW."orderId";
END;

CREATE TRIGGER "OrderComment_order_version_update_bump"
AFTER UPDATE OF "orderId", "author", "body", "createdAt" ON "OrderComment"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = OLD."orderId";
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN NEW."orderId" <> OLD."orderId" AND "resourceVersion" IS NULL THEN 1
    WHEN NEW."orderId" <> OLD."orderId" THEN "resourceVersion" + 1
    ELSE "resourceVersion"
  END
  WHERE NEW."orderId" <> OLD."orderId" AND "id" = NEW."orderId";
END;

CREATE TRIGGER "OrderComment_order_version_delete_bump"
AFTER DELETE ON "OrderComment"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = OLD."orderId";
END;

-- Order responses expose invoice identity and status. Invoice lifecycle or
-- membership changes must therefore invalidate the related Order ETag too.
CREATE TRIGGER "Invoice_order_version_insert_bump"
AFTER INSERT ON "Invoice"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = NEW."orderId";
END;

CREATE TRIGGER "Invoice_order_version_update_bump"
AFTER UPDATE OF "orderId", "number", "status" ON "Invoice"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = OLD."orderId";
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN NEW."orderId" <> OLD."orderId" AND "resourceVersion" IS NULL THEN 1
    WHEN NEW."orderId" <> OLD."orderId" THEN "resourceVersion" + 1
    ELSE "resourceVersion"
  END
  WHERE NEW."orderId" <> OLD."orderId" AND "id" = NEW."orderId";
END;

CREATE TRIGGER "Invoice_order_version_delete_bump"
AFTER DELETE ON "Invoice"
BEGIN
  UPDATE "Order"
  SET "resourceVersion" = CASE
    WHEN "resourceVersion" IS NULL THEN 1
    ELSE "resourceVersion" + 1
  END
  WHERE "id" = OLD."orderId";
END;
