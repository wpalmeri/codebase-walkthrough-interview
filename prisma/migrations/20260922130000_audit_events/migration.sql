-- Additive append-only audit event foundation.
--
-- This migration creates a new, initially empty table and its lookup indexes.
-- It never reads, rewrites, or drops existing business data. The event shape is
-- intentionally narrow: no generic request/error/payload column can retain
-- credentials, idempotency keys, or personal data by accident.
CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "action" TEXT NOT NULL,
  "principalKind" TEXT NOT NULL,
  "principalSubject" TEXT NOT NULL,
  "principalCredentialId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "idempotencyKeyFingerprint" TEXT,
  "resourceKind" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL,
  CONSTRAINT "AuditEvent_principal_subject_check" CHECK (
    length("principalSubject") BETWEEN 1 AND 191
  ),
  CONSTRAINT "AuditEvent_principal_credential_check" CHECK (
    length("principalCredentialId") BETWEEN 1 AND 191
  ),
  CONSTRAINT "AuditEvent_request_id_check" CHECK (
    length("requestId") BETWEEN 1 AND 128
    AND "requestId" GLOB '[A-Za-z0-9]*'
    AND "requestId" NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  CONSTRAINT "AuditEvent_idempotency_key_fingerprint_check" CHECK (
    "idempotencyKeyFingerprint" IS NULL OR (
      length("idempotencyKeyFingerprint") = 64
      AND "idempotencyKeyFingerprint" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT "AuditEvent_resource_id_check" CHECK (
    length("resourceId") BETWEEN 1 AND 512
  )
);

CREATE INDEX "AuditEvent_occurredAt_id_idx"
ON "AuditEvent"("occurredAt", "id");

CREATE INDEX "AuditEvent_resourceKind_resourceId_occurredAt_idx"
ON "AuditEvent"("resourceKind", "resourceId", "occurredAt");

-- SQLite cannot expand a table CHECK without rebuilding the table. Keeping the
-- reviewed enum vocabulary in one insert trigger lets a future additive
-- migration replace this trigger without scanning or rewriting audit history.
CREATE TRIGGER "AuditEvent_insert_guard"
BEFORE INSERT ON "AuditEvent"
WHEN NEW."action" NOT IN (
    'COMBO_DISCOUNT_CREATED', 'RATE_CREATED', 'RATE_UPDATED', 'ORDER_CREATED',
    'ORDER_UPDATED', 'ORDER_INVOICED', 'INVOICE_CREATED', 'INVOICE_UPDATED',
    'INVOICE_POSTED', 'INVOICE_SENT', 'INVOICE_VOIDED',
    'INVOICE_DELIVERY_REQUESTED', 'INVOICE_DELIVERY_UPDATED', 'PAYMENT_RECORDED',
    'PAYMENT_APPLIED', 'PAYMENT_APPLICATION_REVERSED', 'OPERATOR_API_KEY_ISSUED',
    'OPERATOR_API_KEY_REVOKED', 'ACCOUNTING_PERIOD_CLOSED'
  )
  OR NEW."principalKind" NOT IN ('OPERATOR_API_KEY', 'LEGACY_API_KEY', 'DEVELOPMENT')
  OR NEW."resourceKind" NOT IN (
    'COMBO_DISCOUNT', 'RATE', 'ORDER', 'INVOICE', 'INVOICE_DELIVERY', 'PAYMENT',
    'PAYMENT_APPLICATION', 'PAYMENT_APPLICATION_REVERSAL', 'OPERATOR_API_KEY',
    'ACCOUNTING_PERIOD_CONTROL'
  )
  OR NOT (
    (NEW."action" = 'COMBO_DISCOUNT_CREATED' AND NEW."resourceKind" = 'COMBO_DISCOUNT') OR
    (NEW."action" IN ('RATE_CREATED', 'RATE_UPDATED') AND NEW."resourceKind" = 'RATE') OR
    (NEW."action" IN ('ORDER_CREATED', 'ORDER_UPDATED', 'ORDER_INVOICED')
      AND NEW."resourceKind" = 'ORDER') OR
    (NEW."action" IN (
      'INVOICE_CREATED', 'INVOICE_UPDATED', 'INVOICE_POSTED', 'INVOICE_SENT', 'INVOICE_VOIDED'
    ) AND NEW."resourceKind" = 'INVOICE') OR
    (NEW."action" IN ('INVOICE_DELIVERY_REQUESTED', 'INVOICE_DELIVERY_UPDATED')
      AND NEW."resourceKind" = 'INVOICE_DELIVERY') OR
    (NEW."action" = 'PAYMENT_RECORDED' AND NEW."resourceKind" = 'PAYMENT') OR
    (NEW."action" = 'PAYMENT_APPLIED' AND NEW."resourceKind" = 'PAYMENT_APPLICATION') OR
    (NEW."action" = 'PAYMENT_APPLICATION_REVERSED'
      AND NEW."resourceKind" = 'PAYMENT_APPLICATION_REVERSAL') OR
    (NEW."action" IN ('OPERATOR_API_KEY_ISSUED', 'OPERATOR_API_KEY_REVOKED')
      AND NEW."resourceKind" = 'OPERATOR_API_KEY') OR
    (NEW."action" = 'ACCOUNTING_PERIOD_CLOSED'
      AND NEW."resourceKind" = 'ACCOUNTING_PERIOD_CONTROL')
  )
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent action, principal kind, or resource kind is invalid');
END;

CREATE TRIGGER "AuditEvent_append_only_update_guard"
BEFORE UPDATE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent rows are append-only');
END;

CREATE TRIGGER "AuditEvent_append_only_delete_guard"
BEFORE DELETE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent rows are append-only');
END;
