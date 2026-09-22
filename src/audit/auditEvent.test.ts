import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AuditEventAppendInputSchema,
  AuditEventWriteSchema,
  appendAuditEvent,
  fingerprintIdempotencyKey,
  type AuditEventWrite,
} from "./auditEvent";

void describe("append-only audit event helper", () => {
  void test("hashes an idempotency key before persistence with caller-controlled ID and clock", async () => {
    const writes: AuditEventWrite[] = [];
    const rawIdempotencyKey = "client-visible-idempotency-key";
    const event = await appendAuditEvent(
      {
        auditEvent: {
          create: async ({ data }) => {
            writes.push(data);
            return data;
          },
        },
      },
      {
        tenantId: "tenant-audit-a",
        action: "PAYMENT_RECORDED",
        principal: {
          kind: "TENANT_API_KEY",
          subjectId: "service:payment-worker",
          credentialId: "key_audit_a",
        },
        requestId: "request-audit-1",
        idempotencyKey: rawIdempotencyKey,
        resourceKind: "PAYMENT",
        resourceId: "payment-audit-1",
      },
      { id: "audit-event-1", now: () => new Date("2026-09-22T12:00:00.000Z") }
    );

    assert.equal(writes.length, 1);
    assert.equal(event.id, "audit-event-1");
    assert.equal(event.occurredAt.toISOString(), "2026-09-22T12:00:00.000Z");
    assert.equal(event.idempotencyKeyFingerprint, fingerprintIdempotencyKey(rawIdempotencyKey));
    assert.equal(JSON.stringify(writes).includes(rawIdempotencyKey), false);
    assert.equal("idempotencyKey" in writes[0], false);
  });

  void test("keeps both persistable and append input shapes strict", () => {
    assert.equal(
      AuditEventAppendInputSchema.safeParse({
        tenantId: "tenant-audit-a",
        action: "RATE_UPDATED",
        principal: { kind: "TENANT_API_KEY", subjectId: "subject", credentialId: "credential" },
        requestId: "request-audit-2",
        resourceKind: "RATE",
        resourceId: "rate-audit-1",
        payload: { email: "not-allowed@example.com" },
      }).success,
      false
    );
    assert.equal(
      AuditEventWriteSchema.safeParse({
        id: "audit-event-2",
        tenantId: "tenant-audit-a",
        action: "RATE_UPDATED",
        principalKind: "TENANT_API_KEY",
        principalSubject: "subject",
        principalCredentialId: "credential",
        requestId: "request-audit-2",
        idempotencyKeyFingerprint: "a".repeat(64),
        resourceKind: "RATE",
        resourceId: "rate-audit-1",
        occurredAt: "2026-09-22T12:00:00.000Z",
        rawRequest: "not-allowed",
      }).success,
      false
    );
    assert.equal(
      AuditEventAppendInputSchema.safeParse({
        tenantId: "tenant-audit-a",
        action: "PAYMENT_RECORDED",
        principal: { kind: "TENANT_API_KEY", subjectId: "subject", credentialId: "credential" },
        requestId: "request-audit-2",
        resourceKind: "INVOICE",
        resourceId: "invoice-audit-1",
      }).success,
      false
    );
  });
});
