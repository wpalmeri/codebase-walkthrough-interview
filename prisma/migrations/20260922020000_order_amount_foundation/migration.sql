-- Expand-only support for an authoritative exact order-line amount.
--
-- A tiered or discounted line total is not always reproducible by multiplying
-- quantity by a four-decimal blended unit price. Keep that display/provenance
-- price, but persist the rounded line amount independently for billing.
ALTER TABLE "OrderItem" ADD COLUMN "amountDecimal" DECIMAL(19,4);

-- Existing rows remain null intentionally. The application reads the legacy
-- quantity/unit-price calculation until the bounded snapshot backfill supplies
-- this field; no table scan or rewrite occurs in the deploy migration.
