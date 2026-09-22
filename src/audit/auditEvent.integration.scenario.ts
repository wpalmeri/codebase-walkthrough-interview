import assert from "node:assert/strict";
import { appendAuditEvent, fingerprintIdempotencyKey } from "./auditEvent";
import { prisma } from "../db";

type PersistedAuditRow = {
  readonly id: string;
  readonly idempotencyKeyFingerprint: string | null;
};

async function rawInsert(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly action?: string;
  readonly principalKind?: string;
  readonly requestId?: string;
  readonly idempotencyKeyFingerprint?: string | null;
  readonly resourceKind?: string;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "AuditEvent" (
      "id", "tenantId", "action", "principalKind", "principalSubject",
      "principalCredentialId", "requestId", "idempotencyKeyFingerprint",
      "resourceKind", "resourceId", "occurredAt"
    ) VALUES (
      ${input.id}, ${input.tenantId}, ${input.action ?? "RATE_UPDATED"},
      ${input.principalKind ?? "TENANT_API_KEY"}, "audit-subject", "audit-credential",
      ${input.requestId ?? "audit-request-raw"}, ${input.idempotencyKeyFingerprint ?? null},
      ${input.resourceKind ?? "RATE"}, "audit-resource", "2026-09-22T12:00:00.000Z"
    )
  `;
}

async function main(): Promise<void> {
  await prisma.tenant.create({
    data: { id: "audit-tenant", slug: "audit-tenant", name: "Audit Tenant" },
  });
  const rawIdempotencyKey = "audit-idempotency-key-is-transient";
  const appended = await prisma.$transaction((transaction) =>
    appendAuditEvent(
      transaction,
      {
        tenantId: "audit-tenant",
        action: "INVOICE_POSTED",
        principal: {
          kind: "TENANT_API_KEY",
          subjectId: "service:invoice-worker",
          credentialId: "credential-audit-1",
        },
        requestId: "audit-request-1",
        idempotencyKey: rawIdempotencyKey,
        resourceKind: "INVOICE",
        resourceId: "invoice-audit-1",
      },
      { id: "audit-event-1", now: () => new Date("2026-09-22T12:00:00.000Z") }
    )
  );
  assert.equal(appended.idempotencyKeyFingerprint, fingerprintIdempotencyKey(rawIdempotencyKey));
  const persisted = await prisma.$queryRaw<readonly PersistedAuditRow[]>`
    SELECT "id", "idempotencyKeyFingerprint"
    FROM "AuditEvent"
    WHERE "id" = 'audit-event-1'
  `;
  assert.deepEqual(persisted, [
    { id: "audit-event-1", idempotencyKeyFingerprint: fingerprintIdempotencyKey(rawIdempotencyKey) },
  ]);
  assert.equal(JSON.stringify(persisted).includes(rawIdempotencyKey), false);

  await assert.rejects(
    rawInsert({ id: "audit-event-foreign", tenantId: "missing-audit-tenant" }),
    /FOREIGN KEY constraint failed/u
  );
  await assert.rejects(
    rawInsert({ id: "audit-event-invalid-action", tenantId: "audit-tenant", action: "UNREVIEWED_ACTION" }),
    /AuditEvent_action_check/u
  );
  await assert.rejects(
    rawInsert({ id: "audit-event-invalid-principal", tenantId: "audit-tenant", principalKind: "ROOT" }),
    /AuditEvent_principal_kind_check/u
  );
  await assert.rejects(
    rawInsert({ id: "audit-event-invalid-resource", tenantId: "audit-tenant", resourceKind: "UNREVIEWED_KIND" }),
    /AuditEvent_resource_kind_check/u
  );
  await assert.rejects(
    rawInsert({ id: "audit-event-invalid-pair", tenantId: "audit-tenant", action: "PAYMENT_RECORDED", resourceKind: "INVOICE" }),
    /AuditEvent_action_resource_check/u
  );
  await assert.rejects(
    rawInsert({ id: "audit-event-invalid-request", tenantId: "audit-tenant", requestId: ".request" }),
    /AuditEvent_request_id_check/u
  );
  await assert.rejects(
    rawInsert({
      id: "audit-event-invalid-fingerprint",
      tenantId: "audit-tenant",
      idempotencyKeyFingerprint: "A".repeat(64),
    }),
    /AuditEvent_idempotency_key_fingerprint_check/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "AuditEvent" SET "resourceId" = 'changed' WHERE "id" = 'audit-event-1'`,
    /AuditEvent rows are append-only/u
  );
  await assert.rejects(
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = 'audit-event-1'`,
    /AuditEvent rows are append-only/u
  );
  const installed = await prisma.$queryRaw<readonly { name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE name IN (
      'AuditEvent_tenantId_occurredAt_id_idx',
      'AuditEvent_tenantId_resourceKind_resourceId_occurredAt_idx',
      'AuditEvent_append_only_update_guard',
      'AuditEvent_append_only_delete_guard'
    )
  `;
  assert.equal(installed.length, 4);
  await prisma.$disconnect();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
