import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Principal } from "../auth/principal";
import { fingerprintIdempotencyKey, type AuditEventWrite } from "./auditEvent";
import { appendRequestAuditEvent, requestAuditMetadata, RequestAuditMetadataSchema } from "./requestAudit";

const principal: Principal = {
  subjectId: "user-request-audit",
  credentialId: "credential-request-audit",
  kind: "OPERATOR_API_KEY",
  role: "ADMIN",
};

void describe("request audit metadata", () => {
  void test("derives strict metadata from the authenticated principal and hashes a transient key", async () => {
    const rawIdempotencyKey = "request-audit-idempotency-key";
    const metadata = requestAuditMetadata(
      {
        requestId: "request-audit-1",
        get: (name) => (name.toLowerCase() === "idempotency-key" ? rawIdempotencyKey : undefined),
      },
      principal
    );
    const writes: AuditEventWrite[] = [];
    const event = await appendRequestAuditEvent(
      { auditEvent: { create: async ({ data }) => (writes.push(data), data) } },
      metadata,
      { action: "RATE_UPDATED", resourceKind: "RATE", resourceId: "rate-request-audit" },
      { createId: () => "request-audit-event-1", now: () => new Date("2026-09-22T14:00:00.000Z") }
    );

    assert.equal(event.principalSubject, principal.subjectId);
    assert.equal(event.principalCredentialId, principal.credentialId);
    assert.equal(event.requestId, "request-audit-1");
    assert.equal(event.idempotencyKeyFingerprint, fingerprintIdempotencyKey(rawIdempotencyKey));
    assert.equal(JSON.stringify(writes).includes(rawIdempotencyKey), false);
  });

  void test("rejects unrecognized metadata fields and malformed transient keys", () => {
    assert.equal(
      RequestAuditMetadataSchema.safeParse({
        principal: { kind: principal.kind, subjectId: principal.subjectId, credentialId: principal.credentialId },
        requestId: "request-audit-2",
        actorFromBody: "untrusted",
      }).success,
      false
    );
    assert.throws(
      () =>
        requestAuditMetadata(
          { requestId: "request-audit-2", get: () => "contains spaces" },
          principal
        ),
      /printable ASCII/u
    );
  });
});
