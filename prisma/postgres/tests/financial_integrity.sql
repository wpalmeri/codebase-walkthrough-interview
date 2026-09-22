-- Assertions run after the disposable PostgreSQL contract migration.

INSERT INTO "Customer" ("id", "email") VALUES
  ('customer-usd', 'billing@example.test'),
  ('customer-other', 'other@example.test');
INSERT INTO "Product" ("id", "sku", "listPriceDecimal", "currencyCode")
VALUES ('product-1', 'SKU-1', 0.1::numeric + 0.2::numeric, 'USD');
INSERT INTO "Rate" ("id", "customerId", "productId", "unitPriceDecimal", "currencyCode")
VALUES ('rate-1', 'customer-usd', 'product-1', 12.3400, 'USD');
INSERT INTO "Order" ("id", "customerId", "currencyCode")
VALUES ('order-1', 'customer-usd', 'USD');
INSERT INTO "OrderItem" (
  "id", "orderId", "productId", "rateId", "quantityDecimal", "baseUnitPriceDecimal",
  "effectiveUnitPriceDecimal", "amountDecimal", "productSkuSnapshot", "pricingSnapshot", "snapshotVersion"
) VALUES (
  'order-item-1', 'order-1', 'product-1', 'rate-1', 3.000000, 12.3400,
  12.3400, 37.0200, 'SKU-1', '{"version":1,"unitPrice":"12.3400"}', 1
);
INSERT INTO "Invoice" (
  "id", "number", "customerId", "orderId", "status", "totalDecimal", "amountPaidDecimal", "currencyCode", "accountingDate"
) VALUES ('invoice-1', 'INV-PG-1', 'customer-usd', 'order-1', 'POSTED', 100.0000, 0.0000, 'USD', DATE '2026-09-22');
INSERT INTO "Payment" ("id", "customerId", "amountDecimal", "currencyCode")
VALUES
  ('payment-1', 'customer-usd', 200.0000, 'USD'),
  ('payment-capacity', 'customer-usd', 50.0000, 'USD');

DO $$
BEGIN
  IF (SELECT "listPriceDecimal" FROM "Product" WHERE "id" = 'product-1') <> 0.3000 THEN
    RAISE EXCEPTION 'numeric decimal arithmetic did not preserve 0.3000';
  END IF;

  BEGIN
    INSERT INTO "Rate" ("id", "customerId", "productId", "unitPriceDecimal", "currencyCode")
    VALUES ('rate-overflow', 'customer-usd', 'product-1', 1000000000000000.0000, 'USD');
    RAISE EXCEPTION 'NUMERIC(19,4) overflow was accepted';
  EXCEPTION WHEN numeric_value_out_of_range THEN
    NULL;
  END;

  BEGIN
    EXECUTE $statement$UPDATE "Invoice" SET "status" = 'NOT_A_STATUS' WHERE "id" = 'invoice-1'$statement$;
    RAISE EXCEPTION 'invalid invoice enum was accepted';
  EXCEPTION WHEN invalid_text_representation THEN
    NULL;
  END;

  BEGIN
    UPDATE "OrderItem" SET "productSkuSnapshot" = 'REWRITTEN' WHERE "id" = 'order-item-1';
    RAISE EXCEPTION 'immutable pricing snapshot was rewritten';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Order" ("id", "customerId", "currencyCode")
    VALUES ('order-unsupported-currency', 'customer-usd', 'EUR');
    RAISE EXCEPTION 'unsupported currency was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;
