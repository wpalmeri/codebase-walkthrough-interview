-- Expand-safe ledger immutability guards.
--
-- This migration only installs row-level triggers. It does not rebuild, scan,
-- rewrite, or add defaults to an existing business table. The nullable exact
-- fields remain backfillable exactly once during the staged rollout.

-- Once an order line carries captured pricing, its source relationships are
-- provenance rather than editable inputs. Checking NEW also forbids changing a
-- relationship in the same statement that first sets pricingCapturedAt.
CREATE TRIGGER "OrderItem_captured_provenance_immutability_guard"
BEFORE UPDATE OF "orderId", "productId", "rateId" ON "OrderItem"
WHEN NEW."pricingCapturedAt" IS NOT NULL
  AND (
    NEW."orderId" IS NOT OLD."orderId"
    OR NEW."productId" IS NOT OLD."productId"
    OR NEW."rateId" IS NOT OLD."rateId"
  )
BEGIN
  SELECT RAISE(ABORT, 'captured OrderItem provenance is immutable');
END;

-- Capturing any line fixes the commercial party and currency for the entire
-- order. A correction must use a distinct, auditable workflow rather than
-- repointing historic pricing snapshots.
CREATE TRIGGER "Order_captured_item_commercial_identity_immutability_guard"
BEFORE UPDATE OF "customerId", "currencyCode" ON "Order"
WHEN EXISTS (
  SELECT 1
  FROM "OrderItem"
  WHERE "orderId" = OLD."id"
    AND "pricingCapturedAt" IS NOT NULL
)
  AND (
    NEW."customerId" IS NOT OLD."customerId"
    OR NEW."currencyCode" IS NOT OLD."currencyCode"
  )
BEGIN
  SELECT RAISE(ABORT, 'orders with captured items have immutable customer and currency');
END;

-- A payment is a received financial fact. Legacy rows may be populated once
-- with exact amount/currency data, but no captured receipt field may be edited
-- afterwards. Currency's null-to-value path is also validated by existing
-- currency-code and supported-currency triggers.
CREATE TRIGGER "Payment_financial_receipt_immutability_guard"
BEFORE UPDATE OF "id", "customerId", "amount", "amountDecimal", "currencyCode", "receivedAt", "reference" ON "Payment"
WHEN
  NEW."id" IS NOT OLD."id"
  OR NEW."customerId" IS NOT OLD."customerId"
  OR NEW."amount" IS NOT OLD."amount"
  OR NEW."receivedAt" IS NOT OLD."receivedAt"
  OR NEW."reference" IS NOT OLD."reference"
  OR (OLD."amountDecimal" IS NOT NULL AND NEW."amountDecimal" IS NOT OLD."amountDecimal")
  OR (OLD."currencyCode" IS NOT NULL AND NEW."currencyCode" IS NOT OLD."currencyCode")
BEGIN
  SELECT RAISE(ABORT, 'Payment financial receipt fields are immutable after capture');
END;

CREATE TRIGGER "Payment_append_only_delete_guard"
BEFORE DELETE ON "Payment"
BEGIN
  SELECT RAISE(ABORT, 'Payment is append-only and cannot be deleted');
END;

-- Applications are immutable ledger facts. The one permitted update is the
-- nullable exact-amount backfill; any relation, legacy amount, timestamp, or
-- already-captured exact amount change is rejected.
CREATE TRIGGER "PaymentApplication_append_only_update_guard"
BEFORE UPDATE ON "PaymentApplication"
WHEN
  NEW."id" IS NOT OLD."id"
  OR NEW."paymentId" IS NOT OLD."paymentId"
  OR NEW."invoiceId" IS NOT OLD."invoiceId"
  OR NEW."amount" IS NOT OLD."amount"
  OR NEW."appliedAt" IS NOT OLD."appliedAt"
  OR (OLD."amountDecimal" IS NOT NULL AND NEW."amountDecimal" IS NOT OLD."amountDecimal")
BEGIN
  SELECT RAISE(ABORT, 'PaymentApplication is append-only; only null amountDecimal backfill is allowed');
END;

CREATE TRIGGER "PaymentApplication_append_only_delete_guard"
BEFORE DELETE ON "PaymentApplication"
BEGIN
  SELECT RAISE(ABORT, 'PaymentApplication is append-only and cannot be deleted');
END;
