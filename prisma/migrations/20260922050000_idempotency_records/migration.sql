-- Expand-only durable idempotency reservations. This creates a new, empty table
-- and small indexes; no live financial table is scanned, rewritten, or locked.
CREATE TABLE "IdempotencyRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientScope" TEXT NOT NULL,
  "method" TEXT NOT NULL CHECK ("method" IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  "route" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK ("state" IN ('IN_PROGRESS', 'COMPLETED')),
  "responseStatus" INTEGER,
  "responseContentType" TEXT,
  "responseBodyBase64" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  CONSTRAINT "idempotency_completed_response" CHECK (
    ("state" = 'IN_PROGRESS' AND "responseStatus" IS NULL AND "responseContentType" IS NULL AND "responseBodyBase64" IS NULL AND "completedAt" IS NULL)
    OR
    ("state" = 'COMPLETED' AND "responseStatus" IS NOT NULL AND "responseBodyBase64" IS NOT NULL AND "completedAt" IS NOT NULL)
  ),
  CONSTRAINT "IdempotencyRecord_clientScope_method_route_idempotencyKey_key" UNIQUE ("clientScope", "method", "route", "idempotencyKey")
);

CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
