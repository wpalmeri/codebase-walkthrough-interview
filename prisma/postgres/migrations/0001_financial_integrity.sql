-- Disposable PostgreSQL contract schema for CI. See ../README.md.
-- This path intentionally does not change the SQLite demo datasource or its
-- migration history.

CREATE TYPE invoice_status AS ENUM ('DRAFT', 'POSTED', 'SENT', 'PAID', 'VOID');
CREATE TYPE order_status AS ENUM ('OPEN', 'INVOICED', 'CLOSED');

CREATE DOMAIN currency_code AS varchar(3)
  CHECK (VALUE = 'USD');

CREATE TABLE "Customer" (
  "id" text PRIMARY KEY,
  "email" text NOT NULL
);

CREATE TABLE "Product" (
  "id" text PRIMARY KEY,
  "sku" text NOT NULL UNIQUE,
  "listPriceDecimal" numeric(19,4) NOT NULL,
  "currencyCode" currency_code NOT NULL
);

CREATE TABLE "Rate" (
  "id" text PRIMARY KEY,
  "customerId" text NOT NULL REFERENCES "Customer"("id"),
  "productId" text NOT NULL REFERENCES "Product"("id"),
  "unitPriceDecimal" numeric(19,4) NOT NULL CHECK ("unitPriceDecimal" >= 0),
  "currencyCode" currency_code NOT NULL,
  UNIQUE ("customerId", "productId")
);

CREATE TABLE "Order" (
  "id" text PRIMARY KEY,
  "customerId" text NOT NULL REFERENCES "Customer"("id"),
  "status" order_status NOT NULL DEFAULT 'OPEN',
  "currencyCode" currency_code NOT NULL
);

CREATE TABLE "OrderItem" (
  "id" text PRIMARY KEY,
  "orderId" text NOT NULL REFERENCES "Order"("id") ON DELETE CASCADE,
  "productId" text NOT NULL REFERENCES "Product"("id"),
  "rateId" text NOT NULL REFERENCES "Rate"("id"),
  "quantityDecimal" numeric(19,6) NOT NULL CHECK ("quantityDecimal" > 0),
  "baseUnitPriceDecimal" numeric(19,4) NOT NULL CHECK ("baseUnitPriceDecimal" >= 0),
  "effectiveUnitPriceDecimal" numeric(19,4) NOT NULL CHECK ("effectiveUnitPriceDecimal" >= 0),
  "amountDecimal" numeric(19,4) NOT NULL CHECK ("amountDecimal" >= 0),
  "productSkuSnapshot" text NOT NULL,
  "pricingSnapshot" jsonb NOT NULL,
  "pricingCapturedAt" timestamptz NOT NULL DEFAULT now(),
  "snapshotVersion" integer NOT NULL CHECK ("snapshotVersion" > 0)
);

CREATE TABLE "Invoice" (
  "id" text PRIMARY KEY,
  "number" text NOT NULL UNIQUE,
  "customerId" text NOT NULL REFERENCES "Customer"("id"),
  "orderId" text NOT NULL UNIQUE REFERENCES "Order"("id"),
  "status" invoice_status NOT NULL DEFAULT 'DRAFT',
  "totalDecimal" numeric(19,4) NOT NULL CHECK ("totalDecimal" >= 0),
  "amountPaidDecimal" numeric(19,4) NOT NULL DEFAULT 0 CHECK (
    "amountPaidDecimal" >= 0 AND "amountPaidDecimal" <= "totalDecimal"
  ),
  "currencyCode" currency_code NOT NULL,
  "accountingDate" date NOT NULL
);

CREATE TABLE "Payment" (
  "id" text PRIMARY KEY,
  "customerId" text NOT NULL REFERENCES "Customer"("id"),
  "amountDecimal" numeric(19,4) NOT NULL CHECK ("amountDecimal" > 0),
  "currencyCode" currency_code NOT NULL
);

CREATE TABLE "PaymentApplication" (
  "id" text PRIMARY KEY,
  "paymentId" text NOT NULL REFERENCES "Payment"("id"),
  "invoiceId" text NOT NULL REFERENCES "Invoice"("id"),
  "amountDecimal" numeric(19,4) NOT NULL CHECK ("amountDecimal" > 0)
);

CREATE FUNCTION assert_invoice_currency_matches_order()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currencyCode" <> (
    SELECT "currencyCode" FROM "Order" WHERE "id" = NEW."orderId"
  ) THEN
    RAISE EXCEPTION 'invoice currency must match order currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_currency_matches_order
BEFORE INSERT OR UPDATE OF "currencyCode", "orderId" ON "Invoice"
FOR EACH ROW EXECUTE FUNCTION assert_invoice_currency_matches_order();

CREATE FUNCTION assert_order_item_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."productSkuSnapshot" IS DISTINCT FROM OLD."productSkuSnapshot"
    OR NEW."pricingSnapshot" IS DISTINCT FROM OLD."pricingSnapshot"
    OR NEW."pricingCapturedAt" IS DISTINCT FROM OLD."pricingCapturedAt"
    OR NEW."snapshotVersion" IS DISTINCT FROM OLD."snapshotVersion" THEN
    RAISE EXCEPTION 'order pricing snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_item_snapshot_immutable
BEFORE UPDATE ON "OrderItem"
FOR EACH ROW EXECUTE FUNCTION assert_order_item_snapshot_immutable();

CREATE FUNCTION apply_payment(
  requested_payment_id text,
  requested_invoice_id text,
  requested_application_id text,
  requested_amount numeric(19,4)
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_record "Payment"%ROWTYPE;
  invoice_record "Invoice"%ROWTYPE;
  payment_already_applied numeric(19,4);
BEGIN
  -- Lock parent records in a stable order. The payment lock prevents the same
  -- receipt from being overspent across two invoices; the invoice lock serializes
  -- competing applications to the same balance.
  SELECT * INTO payment_record FROM "Payment" WHERE "id" = requested_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO invoice_record FROM "Invoice" WHERE "id" = requested_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice not found' USING ERRCODE = 'P0002';
  END IF;

  IF invoice_record."status" NOT IN ('POSTED', 'SENT') THEN
    RAISE EXCEPTION 'invoice must be POSTED or SENT' USING ERRCODE = '23514';
  END IF;
  IF payment_record."customerId" <> invoice_record."customerId"
    OR payment_record."currencyCode" <> invoice_record."currencyCode" THEN
    RAISE EXCEPTION 'payment and invoice ownership/currency must match' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum("amountDecimal"), 0) INTO payment_already_applied
  FROM "PaymentApplication" WHERE "paymentId" = requested_payment_id;
  IF requested_amount <= 0
    OR payment_already_applied + requested_amount > payment_record."amountDecimal" THEN
    RAISE EXCEPTION 'payment would be over-applied' USING ERRCODE = '23514';
  END IF;
  IF invoice_record."amountPaidDecimal" + requested_amount > invoice_record."totalDecimal" THEN
    RAISE EXCEPTION 'invoice would be overpaid' USING ERRCODE = '23514';
  END IF;

  INSERT INTO "PaymentApplication" ("id", "paymentId", "invoiceId", "amountDecimal")
  VALUES (requested_application_id, requested_payment_id, requested_invoice_id, requested_amount);
  UPDATE "Invoice"
  SET "amountPaidDecimal" = "amountPaidDecimal" + requested_amount,
      "status" = CASE
        WHEN "amountPaidDecimal" + requested_amount = "totalDecimal" THEN 'PAID'::invoice_status
        ELSE "status"
      END
  WHERE "id" = requested_invoice_id;
END;
$$;
