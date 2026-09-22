-- Additive append-only audit event foundation.
--
-- This migration creates a new, initially empty table and its lookup indexes.
-- It never reads, rewrites, or drops existing business data. The event shape is
-- intentionally narrow: no generic request/error/payload column can retain
-- credentials, idempotency keys, or personal data by accident.
CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "principalKind" TEXT NOT NULL,
  "principalSubject" TEXT NOT NULL,
  "principalCredentialId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "idempotencyKeyFingerprint" TEXT,
  "resourceKind" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL,
  CONSTRAINT "AuditEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AuditEvent_action_check" CHECK ("action" IN (
    'RATE_CREATED', 'RATE_UPDATED', 'ORDER_CREATED', 'ORDER_UPDATED', 'ORDER_INVOICED',
    'INVOICE_CREATED', 'INVOICE_POSTED', 'INVOICE_SENT', 'INVOICE_VOIDED',
    'INVOICE_DELIVERY_REQUESTED', 'INVOICE_DELIVERY_UPDATED', 'PAYMENT_RECORDED',
    'PAYMENT_APPLIED', 'PAYMENT_APPLICATION_REVERSED', 'TENANT_API_KEY_ISSUED',
    'TENANT_API_KEY_REVOKED'
  )),
  CONSTRAINT "AuditEvent_principal_kind_check" CHECK ("principalKind" IN (
    'TENANT_API_KEY', 'LEGACY_API_KEY', 'DEVELOPMENT'
  )),
  CONSTRAINT "AuditEvent_resource_kind_check" CHECK ("resourceKind" IN (
    'RATE', 'ORDER', 'INVOICE', 'INVOICE_DELIVERY', 'PAYMENT',
    'PAYMENT_APPLICATION', 'PAYMENT_APPLICATION_REVERSAL', 'TENANT_API_KEY'
  )),
  CONSTRAINT "AuditEvent_action_resource_check" CHECK (
    ("action" IN ('RATE_CREATED', 'RATE_UPDATED') AND "resourceKind" = 'RATE') OR
    ("action" IN ('ORDER_CREATED', 'ORDER_UPDATED', 'ORDER_INVOICED') AND "resourceKind" = 'ORDER') OR
    ("action" IN ('INVOICE_CREATED', 'INVOICE_POSTED', 'INVOICE_SENT', 'INVOICE_VOIDED')
      AND "resourceKind" = 'INVOICE') OR
    ("action" IN ('INVOICE_DELIVERY_REQUESTED', 'INVOICE_DELIVERY_UPDATED')
      AND "resourceKind" = 'INVOICE_DELIVERY') OR
    ("action" = 'PAYMENT_RECORDED' AND "resourceKind" = 'PAYMENT') OR
    ("action" = 'PAYMENT_APPLIED' AND "resourceKind" = 'PAYMENT_APPLICATION') OR
    ("action" = 'PAYMENT_APPLICATION_REVERSED'
      AND "resourceKind" = 'PAYMENT_APPLICATION_REVERSAL') OR
    ("action" IN ('TENANT_API_KEY_ISSUED', 'TENANT_API_KEY_REVOKED')
      AND "resourceKind" = 'TENANT_API_KEY')
  ),
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

CREATE INDEX "AuditEvent_tenantId_occurredAt_id_idx"
ON "AuditEvent"("tenantId", "occurredAt", "id");

CREATE INDEX "AuditEvent_tenantId_resourceKind_resourceId_occurredAt_idx"
ON "AuditEvent"("tenantId", "resourceKind", "resourceId", "occurredAt");

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
