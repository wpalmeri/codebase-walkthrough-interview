-- The application currently implements USD minor-unit, rounding, formatting,
-- and settlement semantics only. Keep rollout columns nullable for historical
-- backfill, but reject any newly populated unsupported currency without
-- scanning or rewriting existing rows.

CREATE TRIGGER "Product_supported_currency_insert_guard"
BEFORE INSERT ON "Product"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Product.currencyCode must be USD');
END;

CREATE TRIGGER "Product_supported_currency_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Product"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Product.currencyCode must be USD');
END;

CREATE TRIGGER "Rate_supported_currency_insert_guard"
BEFORE INSERT ON "Rate"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Rate.currencyCode must be USD');
END;

CREATE TRIGGER "Rate_supported_currency_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Rate"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Rate.currencyCode must be USD');
END;

CREATE TRIGGER "Order_supported_currency_insert_guard"
BEFORE INSERT ON "Order"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Order.currencyCode must be USD');
END;

CREATE TRIGGER "Order_supported_currency_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Order"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Order.currencyCode must be USD');
END;

CREATE TRIGGER "Invoice_supported_currency_insert_guard"
BEFORE INSERT ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Invoice.currencyCode must be USD');
END;

CREATE TRIGGER "Invoice_supported_currency_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Invoice"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Invoice.currencyCode must be USD');
END;

CREATE TRIGGER "Payment_supported_currency_insert_guard"
BEFORE INSERT ON "Payment"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Payment.currencyCode must be USD');
END;

CREATE TRIGGER "Payment_supported_currency_update_guard"
BEFORE UPDATE OF "currencyCode" ON "Payment"
WHEN NEW."currencyCode" IS NOT NULL AND NEW."currencyCode" <> 'USD'
BEGIN
  SELECT RAISE(ABORT, 'Payment.currencyCode must be USD');
END;
