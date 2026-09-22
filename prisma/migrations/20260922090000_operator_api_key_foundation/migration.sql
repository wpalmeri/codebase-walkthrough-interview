-- Global operator credential foundation.
--
-- Meridian owns this database; customers are bill-to entities.
-- This empty-table migration stores only a one-way credential digest and a
-- non-secret lookup prefix. It never touches commercial or financial rows.
CREATE TABLE "OperatorApiKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'BILLING',
  "keyPrefix" TEXT NOT NULL UNIQUE,
  "keyHash" TEXT NOT NULL UNIQUE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "lastUsedAt" DATETIME,
  CONSTRAINT "OperatorApiKey_name_key" UNIQUE ("name"),
  CONSTRAINT "OperatorApiKey_role_check" CHECK ("role" IN ('ADMIN', 'BILLING', 'VIEWER'))
);

CREATE INDEX "OperatorApiKey_revokedAt_idx" ON "OperatorApiKey"("revokedAt");

CREATE TRIGGER "OperatorApiKey_input_guard"
BEFORE INSERT ON "OperatorApiKey"
WHEN length(trim(NEW."name")) = 0
  OR length(NEW."name") > 160
  OR length(trim(NEW."keyPrefix")) = 0
  OR length(NEW."keyPrefix") > 128
  OR length(trim(NEW."keyHash")) < 32
BEGIN
  SELECT RAISE(ABORT, 'invalid OperatorApiKey input');
END;

-- Identity and privilege are issued facts. Revocation is intentionally the
-- only lifecycle transition allowed on an existing credential.
CREATE TRIGGER "OperatorApiKey_identity_immutability_guard"
BEFORE UPDATE OF "keyPrefix", "keyHash", "role" ON "OperatorApiKey"
WHEN NEW."keyPrefix" IS NOT OLD."keyPrefix"
  OR NEW."keyHash" IS NOT OLD."keyHash"
  OR NEW."role" IS NOT OLD."role"
BEGIN
  SELECT RAISE(ABORT, 'OperatorApiKey identity and role are immutable');
END;
