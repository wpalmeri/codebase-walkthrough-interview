-- Expand-only rate conditional-write support.
--
-- This migration touches no existing business values. The nullable replay ETag
-- preserves exact idempotent response headers, while Rate triggers initialize
-- future rows and invalidate ETags for direct/legacy business updates.

ALTER TABLE "IdempotencyRecord" ADD COLUMN "responseEtag" TEXT;

-- Future Rate inserts get a concrete first version without a default or a
-- table-wide rewrite. The resource-version guard installed in the preceding
-- migration validates this null-to-one transition.
CREATE TRIGGER "Rate_resource_version_initialize"
AFTER INSERT ON "Rate"
WHEN NEW."resourceVersion" IS NULL
BEGIN
  UPDATE "Rate"
  SET "resourceVersion" = 1
  WHERE "id" = NEW."id" AND "resourceVersion" IS NULL;
END;

-- Legacy writers and controlled SQL maintenance may still update Rate business
-- columns without a CAS predicate. Advance the version exactly once so a
-- representation fetched before that write cannot be used after it. A
-- conditional-write endpoint sets resourceVersion itself, which suppresses
-- this trigger and avoids a double increment.
CREATE TRIGGER "Rate_resource_version_business_update_bump"
AFTER UPDATE OF
  "customerId",
  "productId",
  "unitPrice",
  "unitPriceDecimal",
  "currencyCode",
  "tiers",
  "effectiveDate"
ON "Rate"
WHEN NEW."resourceVersion" IS OLD."resourceVersion"
BEGIN
  UPDATE "Rate"
  SET "resourceVersion" = CASE
    WHEN OLD."resourceVersion" IS NULL THEN 1
    ELSE OLD."resourceVersion" + 1
  END
  WHERE "id" = NEW."id" AND "resourceVersion" IS OLD."resourceVersion";
END;
