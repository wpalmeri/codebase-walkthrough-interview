-- Expand-only tenant ownership foundation.
--
-- This migration creates empty identity/credential/control tables, adds only
-- nullable ownership columns plus lookup indexes, and installs row-local
-- integrity triggers. It does not scan, rewrite, rebuild, or drop legacy
-- business data. A later bounded backfill reconciles legacy rows before the
-- runtime switches to tenant-scoped reads and a contract migration requires
-- ownership.

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Secrets are deliberately absent: keyHash stores a versioned one-way digest
-- and keyPrefix is a non-secret operator-facing identifier.
CREATE TABLE "TenantApiKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'BILLING',
  "keyPrefix" TEXT NOT NULL UNIQUE,
  "keyHash" TEXT NOT NULL UNIQUE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "lastUsedAt" DATETIME,
  CONSTRAINT "TenantApiKey_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantApiKey_tenantId_name_key" UNIQUE ("tenantId", "name"),
  CONSTRAINT "TenantApiKey_role_check" CHECK ("role" IN ('ADMIN', 'BILLING', 'VIEWER'))
);

CREATE INDEX "TenantApiKey_tenantId_revokedAt_idx"
ON "TenantApiKey"("tenantId", "revokedAt");

CREATE TABLE "UserIdentity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserIdentity_issuer_subject_key" UNIQUE ("issuer", "subject")
);

CREATE TABLE "TenantMembership" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "userIdentityId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  CONSTRAINT "TenantMembership_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantMembership_userIdentityId_fkey"
    FOREIGN KEY ("userIdentityId") REFERENCES "UserIdentity" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantMembership_tenantId_userIdentityId_key"
    UNIQUE ("tenantId", "userIdentityId"),
  CONSTRAINT "TenantMembership_role_check"
    CHECK ("role" IN ('ADMIN', 'BILLING', 'VIEWER'))
);

CREATE INDEX "TenantMembership_userIdentityId_revokedAt_idx"
ON "TenantMembership"("userIdentityId", "revokedAt");

-- This is deliberately separate from the temporary legacy-global close
-- control. The eventual tenant scoped close workflow owns this table.
CREATE TABLE "TenantAccountingPeriodControl" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL UNIQUE,
  "closedThroughDate" TEXT,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "TenantAccountingPeriodControl_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Nullable ownership columns preserve compatibility for existing rows and
-- avoid a data scan/default rewrite during deploy.
ALTER TABLE "Customer" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComboDiscount" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD COLUMN "tenantId" TEXT REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");
CREATE INDEX "ComboDiscount_tenantId_idx" ON "ComboDiscount"("tenantId");
CREATE INDEX "Order_tenantId_idx" ON "Order"("tenantId");
CREATE INDEX "Invoice_tenantId_idx" ON "Invoice"("tenantId");
CREATE INDEX "Payment_tenantId_idx" ON "Payment"("tenantId");
CREATE INDEX "IdempotencyRecord_tenantId_idx" ON "IdempotencyRecord"("tenantId");

CREATE TRIGGER "Tenant_input_guard"
BEFORE INSERT ON "Tenant"
WHEN length(trim(NEW."slug")) = 0
  OR length(NEW."slug") > 100
  OR length(trim(NEW."name")) = 0
  OR length(NEW."name") > 250
BEGIN
  SELECT RAISE(ABORT, 'invalid Tenant input');
END;

CREATE TRIGGER "TenantApiKey_input_guard"
BEFORE INSERT ON "TenantApiKey"
WHEN length(trim(NEW."name")) = 0
  OR length(NEW."name") > 160
  OR length(trim(NEW."keyPrefix")) = 0
  OR length(NEW."keyPrefix") > 128
  OR length(trim(NEW."keyHash")) < 32
BEGIN
  SELECT RAISE(ABORT, 'invalid TenantApiKey input');
END;

CREATE TRIGGER "TenantApiKey_identity_immutability_guard"
BEFORE UPDATE OF "tenantId", "keyPrefix", "keyHash", "role" ON "TenantApiKey"
WHEN NEW."tenantId" IS NOT OLD."tenantId"
  OR NEW."keyPrefix" IS NOT OLD."keyPrefix"
  OR NEW."keyHash" IS NOT OLD."keyHash"
  OR NEW."role" IS NOT OLD."role"
BEGIN
  SELECT RAISE(ABORT, 'TenantApiKey identity and role are immutable');
END;

CREATE TRIGGER "UserIdentity_input_guard"
BEFORE INSERT ON "UserIdentity"
WHEN length(trim(NEW."issuer")) = 0
  OR length(NEW."issuer") > 500
  OR length(trim(NEW."subject")) = 0
  OR length(NEW."subject") > 500
BEGIN
  SELECT RAISE(ABORT, 'invalid UserIdentity input');
END;

CREATE TRIGGER "UserIdentity_subject_immutability_guard"
BEFORE UPDATE OF "issuer", "subject" ON "UserIdentity"
WHEN NEW."issuer" IS NOT OLD."issuer"
  OR NEW."subject" IS NOT OLD."subject"
BEGIN
  SELECT RAISE(ABORT, 'UserIdentity issuer and subject are immutable');
END;

CREATE TRIGGER "TenantMembership_identity_immutability_guard"
BEFORE UPDATE OF "tenantId", "userIdentityId", "role" ON "TenantMembership"
WHEN NEW."tenantId" IS NOT OLD."tenantId"
  OR NEW."userIdentityId" IS NOT OLD."userIdentityId"
  OR NEW."role" IS NOT OLD."role"
BEGIN
  SELECT RAISE(ABORT, 'TenantMembership identity and role are immutable');
END;

CREATE TRIGGER "TenantAccountingPeriodControl_date_insert_guard"
BEFORE INSERT ON "TenantAccountingPeriodControl"
WHEN NEW."closedThroughDate" IS NOT NULL
  AND (
    length(NEW."closedThroughDate") <> 10
    OR NEW."closedThroughDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR strftime('%Y-%m-%d', NEW."closedThroughDate") IS NOT NEW."closedThroughDate"
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid TenantAccountingPeriodControl.closedThroughDate');
END;

CREATE TRIGGER "TenantAccountingPeriodControl_date_update_guard"
BEFORE UPDATE OF "closedThroughDate" ON "TenantAccountingPeriodControl"
WHEN (NEW."closedThroughDate" IS NOT NULL AND (
    length(NEW."closedThroughDate") <> 10
    OR NEW."closedThroughDate" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR strftime('%Y-%m-%d', NEW."closedThroughDate") IS NOT NEW."closedThroughDate"
  ))
  OR (OLD."closedThroughDate" IS NOT NULL AND NEW."closedThroughDate" IS NULL)
  OR (OLD."closedThroughDate" IS NOT NULL AND NEW."closedThroughDate" < OLD."closedThroughDate")
BEGIN
  SELECT RAISE(ABORT, 'invalid TenantAccountingPeriodControl.closedThroughDate transition');
END;

-- The nullable columns carry real foreign keys. These triggers additionally
-- freeze assigned ownership and enforce same-tenant commercial relationships
-- while retaining the required nullable expand path.
CREATE TRIGGER "Customer_tenant_guard"
BEFORE INSERT ON "Customer"
WHEN NEW."tenantId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId")
BEGIN
  SELECT RAISE(ABORT, 'Customer.tenantId must reference an existing Tenant');
END;

CREATE TRIGGER "Customer_tenant_update_guard"
BEFORE UPDATE OF "tenantId" ON "Customer"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Order" WHERE "customerId" = OLD."id" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Invoice" WHERE "customerId" = OLD."id" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Payment" WHERE "customerId" = OLD."id" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "ComboDiscount" WHERE "customerId" = OLD."id" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Rate" AS rate JOIN "Product" AS product ON product."id" = rate."productId"
    WHERE rate."customerId" = OLD."id" AND product."tenantId" IS NOT NULL AND product."tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Customer tenant conflicts with related commercial records');
END;

CREATE TRIGGER "Product_tenant_guard"
BEFORE INSERT ON "Product"
WHEN NEW."tenantId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId")
BEGIN
  SELECT RAISE(ABORT, 'Product.tenantId must reference an existing Tenant');
END;

CREATE TRIGGER "Product_tenant_update_guard"
BEFORE UPDATE OF "tenantId" ON "Product"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Rate" AS rate JOIN "Customer" AS customer ON customer."id" = rate."customerId"
    WHERE rate."productId" = OLD."id" AND customer."tenantId" IS NOT NULL AND customer."tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "OrderItem" AS item JOIN "Order" AS orders ON orders."id" = item."orderId"
    WHERE item."productId" = OLD."id" AND orders."tenantId" IS NOT NULL AND orders."tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "_ComboDiscountToProduct" AS link JOIN "ComboDiscount" AS combo ON combo."id" = link."A"
    WHERE link."B" = OLD."id" AND combo."tenantId" IS NOT NULL AND combo."tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Product tenant conflicts with related commercial records');
END;

CREATE TRIGGER "ComboDiscount_tenant_guard"
BEFORE INSERT ON "ComboDiscount"
WHEN (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'ComboDiscount tenant conflicts with customer');
END;

CREATE TRIGGER "ComboDiscount_tenant_update_guard"
BEFORE UPDATE OF "tenantId", "customerId" ON "ComboDiscount"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "_ComboDiscountToProduct" AS link JOIN "Product" AS product ON product."id" = link."B"
    WHERE link."A" = OLD."id" AND product."tenantId" IS NOT NULL AND product."tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'ComboDiscount tenant conflicts with related commercial records');
END;

CREATE TRIGGER "Order_tenant_guard"
BEFORE INSERT ON "Order"
WHEN (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Order tenant conflicts with customer');
END;

CREATE TRIGGER "Order_tenant_update_guard"
BEFORE UPDATE OF "tenantId", "customerId" ON "Order"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Invoice" WHERE "orderId" = OLD."id" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "OrderItem" AS item JOIN "Product" AS product ON product."id" = item."productId"
    WHERE item."orderId" = OLD."id" AND product."tenantId" IS NOT NULL AND product."tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Order tenant conflicts with related commercial records');
END;

CREATE TRIGGER "Invoice_tenant_guard"
BEFORE INSERT ON "Invoice"
WHEN (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invoice tenant conflicts with customer or order');
END;

CREATE TRIGGER "Invoice_tenant_update_guard"
BEFORE UPDATE OF "tenantId", "customerId", "orderId" ON "Invoice"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Order" WHERE "id" = NEW."orderId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "PaymentApplication" AS application JOIN "Payment" AS payment ON payment."id" = application."paymentId"
    WHERE application."invoiceId" = OLD."id" AND payment."tenantId" IS NOT NULL AND payment."tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invoice tenant conflicts with related commercial records');
END;

CREATE TRIGGER "Payment_tenant_guard"
BEFORE INSERT ON "Payment"
WHEN (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" IS NOT NULL AND "tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Payment tenant conflicts with customer');
END;

CREATE TRIGGER "Payment_tenant_update_guard"
BEFORE UPDATE OF "tenantId" ON "Payment"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
  OR (NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Invoice" AS invoice WHERE invoice."customerId" = NEW."customerId" AND invoice."tenantId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "PaymentApplication" WHERE "paymentId" = OLD."id" AND "invoiceId" = invoice."id")
      AND invoice."tenantId" IS NOT NEW."tenantId"
  ))
BEGIN
  SELECT RAISE(ABORT, 'Payment tenant conflicts with related commercial records');
END;

CREATE TRIGGER "IdempotencyRecord_tenant_guard"
BEFORE INSERT ON "IdempotencyRecord"
WHEN NEW."tenantId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId")
BEGIN
  SELECT RAISE(ABORT, 'IdempotencyRecord.tenantId must reference an existing Tenant');
END;

CREATE TRIGGER "IdempotencyRecord_tenant_update_guard"
BEFORE UPDATE OF "tenantId" ON "IdempotencyRecord"
WHEN (OLD."tenantId" IS NOT NULL AND NEW."tenantId" IS NOT OLD."tenantId")
  OR (NEW."tenantId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = NEW."tenantId"))
BEGIN
  SELECT RAISE(ABORT, 'IdempotencyRecord.tenantId is immutable once set');
END;

-- Related tables infer tenancy from their immutable parents. These checks stop
-- a mixed-tenant relationship from being created even before all legacy rows
-- have received their own nullable tenantId.
CREATE TRIGGER "Rate_tenant_identity_guard"
BEFORE INSERT ON "Rate"
WHEN EXISTS (
  SELECT 1 FROM "Customer" AS customer JOIN "Product" AS product
    WHERE customer."id" = NEW."customerId" AND product."id" = NEW."productId"
      AND customer."tenantId" IS NOT NULL AND product."tenantId" IS NOT NULL
      AND customer."tenantId" IS NOT product."tenantId"
)
BEGIN
  SELECT RAISE(ABORT, 'Rate customer and product must share a tenant');
END;

CREATE TRIGGER "Rate_tenant_identity_update_guard"
BEFORE UPDATE OF "customerId", "productId" ON "Rate"
WHEN EXISTS (
  SELECT 1 FROM "Customer" AS customer JOIN "Product" AS product
    WHERE customer."id" = NEW."customerId" AND product."id" = NEW."productId"
      AND customer."tenantId" IS NOT NULL AND product."tenantId" IS NOT NULL
      AND customer."tenantId" IS NOT product."tenantId"
)
BEGIN
  SELECT RAISE(ABORT, 'Rate customer and product must share a tenant');
END;

CREATE TRIGGER "OrderItem_tenant_identity_guard"
BEFORE INSERT ON "OrderItem"
WHEN EXISTS (
  SELECT 1
  FROM "Order" AS orders
  JOIN "Product" AS product ON product."id" = NEW."productId"
  JOIN "Rate" AS rate ON rate."id" = NEW."rateId"
  JOIN "Customer" AS rateCustomer ON rateCustomer."id" = rate."customerId"
  WHERE orders."id" = NEW."orderId"
    AND ((orders."tenantId" IS NOT NULL AND product."tenantId" IS NOT NULL AND orders."tenantId" IS NOT product."tenantId")
      OR (orders."tenantId" IS NOT NULL AND rateCustomer."tenantId" IS NOT NULL AND orders."tenantId" IS NOT rateCustomer."tenantId")
      OR (product."tenantId" IS NOT NULL AND rateCustomer."tenantId" IS NOT NULL AND product."tenantId" IS NOT rateCustomer."tenantId"))
)
BEGIN
  SELECT RAISE(ABORT, 'OrderItem order, product, and rate must share a tenant');
END;

CREATE TRIGGER "OrderItem_tenant_identity_update_guard"
BEFORE UPDATE OF "orderId", "productId", "rateId" ON "OrderItem"
WHEN EXISTS (
  SELECT 1
  FROM "Order" AS orders
  JOIN "Product" AS product ON product."id" = NEW."productId"
  JOIN "Rate" AS rate ON rate."id" = NEW."rateId"
  JOIN "Customer" AS rateCustomer ON rateCustomer."id" = rate."customerId"
  WHERE orders."id" = NEW."orderId"
    AND ((orders."tenantId" IS NOT NULL AND product."tenantId" IS NOT NULL AND orders."tenantId" IS NOT product."tenantId")
      OR (orders."tenantId" IS NOT NULL AND rateCustomer."tenantId" IS NOT NULL AND orders."tenantId" IS NOT rateCustomer."tenantId")
      OR (product."tenantId" IS NOT NULL AND rateCustomer."tenantId" IS NOT NULL AND product."tenantId" IS NOT rateCustomer."tenantId"))
)
BEGIN
  SELECT RAISE(ABORT, 'OrderItem order, product, and rate must share a tenant');
END;

CREATE TRIGGER "ComboDiscount_product_tenant_identity_guard"
BEFORE INSERT ON "_ComboDiscountToProduct"
WHEN EXISTS (
  SELECT 1 FROM "ComboDiscount" AS combo JOIN "Product" AS product
    WHERE combo."id" = NEW."A" AND product."id" = NEW."B"
      AND combo."tenantId" IS NOT NULL AND product."tenantId" IS NOT NULL
      AND combo."tenantId" IS NOT product."tenantId"
)
BEGIN
  SELECT RAISE(ABORT, 'ComboDiscount and Product must share a tenant');
END;

CREATE TRIGGER "PaymentApplication_tenant_identity_guard"
BEFORE INSERT ON "PaymentApplication"
WHEN EXISTS (
  SELECT 1 FROM "Payment" AS payment JOIN "Invoice" AS invoice
    WHERE payment."id" = NEW."paymentId" AND invoice."id" = NEW."invoiceId"
      AND payment."tenantId" IS NOT NULL AND invoice."tenantId" IS NOT NULL
      AND payment."tenantId" IS NOT invoice."tenantId"
)
BEGIN
  SELECT RAISE(ABORT, 'PaymentApplication payment and invoice must share a tenant');
END;

CREATE TRIGGER "PaymentApplication_tenant_identity_update_guard"
BEFORE UPDATE OF "paymentId", "invoiceId" ON "PaymentApplication"
WHEN EXISTS (
  SELECT 1 FROM "Payment" AS payment JOIN "Invoice" AS invoice
    WHERE payment."id" = NEW."paymentId" AND invoice."id" = NEW."invoiceId"
      AND payment."tenantId" IS NOT NULL AND invoice."tenantId" IS NOT NULL
      AND payment."tenantId" IS NOT invoice."tenantId"
)
BEGIN
  SELECT RAISE(ABORT, 'PaymentApplication payment and invoice must share a tenant');
END;

-- Existing business tables reference Tenant through triggers, so protect the
-- tenant delete path just as foreign keys would.
CREATE TRIGGER "Tenant_referenced_delete_guard"
BEFORE DELETE ON "Tenant"
WHEN EXISTS (SELECT 1 FROM "Customer" WHERE "tenantId" = OLD."id")
  OR EXISTS (SELECT 1 FROM "Product" WHERE "tenantId" = OLD."id")
  OR EXISTS (SELECT 1 FROM "ComboDiscount" WHERE "tenantId" = OLD."id")
  OR EXISTS (SELECT 1 FROM "Order" WHERE "tenantId" = OLD."id")
  OR EXISTS (SELECT 1 FROM "Invoice" WHERE "tenantId" = OLD."id")
  OR EXISTS (SELECT 1 FROM "Payment" WHERE "tenantId" = OLD."id")
  OR EXISTS (SELECT 1 FROM "IdempotencyRecord" WHERE "tenantId" = OLD."id")
BEGIN
  SELECT RAISE(ABORT, 'Tenant has referenced business records');
END;
