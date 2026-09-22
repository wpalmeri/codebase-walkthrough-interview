import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { z } from "zod";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const admin: Principal = {
  subjectId: "operator:accounting-close-admin",
  credentialId: "accounting-close-admin",
  kind: "OPERATOR_API_KEY",
  role: "ADMIN",
};

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

async function request(server: Server, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer close-admin", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: record(await response.json()) };
}

async function main(): Promise<void> {
  await prisma.operatorApiKey.create({
    data: {
      id: admin.credentialId,
      name: "accounting close admin",
      role: "ADMIN",
      keyPrefix: "mrd_accountingclose",
      keyHash: "hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
  await prisma.operatorApiKey.create({
    data: {
      id: "accounting-close-admin-backup",
      name: "accounting close backup admin",
      role: "ADMIN",
      keyPrefix: "mrd_accountingbackup",
      keyHash: "hmac-sha256:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });
  const app = createApp({ environment: "test", apiKey: "", principalResolver: { resolve: async (token) => token === "close-admin" ? admin : null } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    assert.equal((await request(server, "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-30" })).status, 400);
    const key = "accounting-close-first";
    const first = await request(server, "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-31" }, {
      "x-request-id": "accounting-close-first-request", "idempotency-key": key, "idempotency-client": "close-console",
    });
    assert.deepEqual([first.status, first.body.state, first.body.closedThroughDate], [200, "CLOSED", "2026-01-31"]);
    const replay = await request(server, "/api/accounting-periods/close", { closedThroughDate: "2026-01-31" }, {
      "idempotency-key": key, "idempotency-client": "close-console",
    });
    assert.deepEqual(replay.body, first.body);
    const control = await prisma.accountingPeriodControl.findUniqueOrThrow({ where: { id: 1 } });
    const audits = await prisma.auditEvent.findMany({ where: { action: "ACCOUNTING_PERIOD_CLOSED" } });
    assert.equal(audits.length, 1);
    assert.deepEqual(
      [audits[0]?.resourceId, audits[0]?.principalCredentialId, audits[0]?.idempotencyKeyFingerprint],
      [String(control.id), admin.credentialId, fingerprintIdempotencyKey(key)]
    );
    const lower = await request(server, "/api/v1/accounting-periods/close", { closedThroughDate: "2026-01-30" });
    assert.deepEqual([lower.status, lower.body.code], [409, "ACCOUNTING_PERIOD_CLOSE_MOVES_BACKWARD"]);
    await prisma.operatorApiKey.update({ where: { id: admin.credentialId }, data: { revokedAt: new Date() } });
    assert.equal((await request(server, "/api/v1/accounting-periods/close", { closedThroughDate: "2026-02-28" })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
