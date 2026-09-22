import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { join } from "node:path";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import type { RequestAuditMetadata } from "../audit/requestAudit";
import * as invoices from "../controllers/invoiceController";
import * as orders from "../controllers/orderController";
import { prisma } from "../db";
import { z } from "zod";

const migration = join(process.cwd(), "prisma/migrations/20260922140000_order_conditional_writes/migration.sql");
const tenantA = "order-conditional-a";
const tenantB = "order-conditional-b";
const principals: Record<string, Principal> = {
  a: { tenantId: tenantA, subjectId: "order-admin-a", credentialId: "order-key-a", kind: "TENANT_API_KEY", role: "BILLING" },
  b: { tenantId: tenantB, subjectId: "order-admin-b", credentialId: "order-key-b", kind: "TENANT_API_KEY", role: "BILLING" },
};
const audit = (principal: Principal, requestId: string): RequestAuditMetadata => ({
  tenantId: principal.tenantId,
  principal: { kind: principal.kind, subjectId: principal.subjectId, credentialId: principal.credentialId },
  requestId,
});
type Reply = { status: number; body: unknown; etag: string | null };
async function request(server: Server, token: "a" | "b", path: string, init: RequestInit = {}): Promise<Reply> {
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing server address");
  const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, { ...init, headers });
  return { status: response.status, body: await response.json(), etag: response.headers.get("etag") };
}
const code = (body: unknown) => z.object({ code: z.string() }).passthrough().parse(body).code;
async function close(server: Server) { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }

async function seed(): Promise<{ orderId: string; otherOrderId: string; itemId: string }> {
  await prisma.tenant.createMany({ data: [{ id: tenantA, slug: tenantA, name: tenantA }, { id: tenantB, slug: tenantB, name: tenantB }] });
  const [customerA, customerB] = await Promise.all([
    prisma.customer.create({ data: { tenantId: tenantA, name: "A", email: "a@example.com" } }),
    prisma.customer.create({ data: { tenantId: tenantB, name: "B", email: "b@example.com" } }),
  ]);
  const [productA, productB] = await Promise.all([
    prisma.product.create({ data: { tenantId: tenantA, sku: "order-a", name: "A", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" } }),
    prisma.product.create({ data: { tenantId: tenantB, sku: "order-b", name: "B", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" } }),
  ]);
  const [created, other] = await Promise.all([
    orders.createOrder(tenantA, { customerId: customerA.id, items: [{ productId: productA.id, quantity: 1 }] }, audit(principals.a, "seed-a")),
    orders.createOrder(tenantB, { customerId: customerB.id, items: [{ productId: productB.id, quantity: 1 }] }, audit(principals.b, "seed-b")),
  ]);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).resourceVersion, null);
  return { orderId: created.id, otherOrderId: other.id, itemId: created.items[0].id };
}

async function main() {
  const seeded = await seed();
  execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), ["db", "execute", "--url", process.env.DATABASE_URL ?? "", "--file", migration], { stdio: "pipe" });
  const app = createApp({ principalResolver: { resolve: async (token) => principals[token] ?? null } });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const initial = await request(server, "a", `/orders/${seeded.orderId}`); assert.equal(initial.status, 200); assert.ok(initial.etag);
    for (const [tag, status, expected] of [[undefined, 428, "PRECONDITION_REQUIRED"], ["W/\"x\"", 400, "IF_MATCH_MALFORMED"], ["*", 400, "IF_MATCH_MALFORMED"], ["\"a\", \"b\"", 400, "IF_MATCH_MALFORMED"]] as const) {
      const reply = await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: tag === undefined ? {} : { "if-match": tag }, body: JSON.stringify({ notes: "x" }) });
      assert.equal(reply.status, status); assert.equal(code(reply.body), expected);
    }
    const cross = await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: { "if-match": (await request(server, "b", `/orders/${seeded.otherOrderId}`)).etag! }, body: JSON.stringify({ notes: "x" }) });
    assert.equal(cross.status, 412); assert.equal(code(cross.body), "ETAG_RESOURCE_MISMATCH");
    const foreign = await request(server, "a", `/orders/${seeded.otherOrderId}`, { method: "PATCH", headers: { "if-match": "bad" }, body: JSON.stringify({ notes: "x" }) });
    const missing = await request(server, "a", "/orders/missing", { method: "PATCH", headers: { "if-match": "bad" }, body: JSON.stringify({ notes: "x" }) });
    assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
    const [one, two] = await Promise.all(["one", "two"].map((notes) => request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: { "if-match": initial.etag! }, body: JSON.stringify({ notes }) })));
    assert.equal([one, two].filter((reply) => reply.status === 200).length, 1); assert.equal([one, two].filter((reply) => reply.status === 412).length, 1);
    const current = await request(server, "a", `/orders/${seeded.orderId}`); const key = "order-cas-replay";
    const headers = { "if-match": current.etag!, "idempotency-key": key, "x-request-id": "order-replay-request" };
    const first = await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers, body: JSON.stringify({ notes: "replayed" }) });
    const replay = await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers, body: JSON.stringify({ notes: "replayed" }) });
    assert.equal(first.status, 200); assert.equal(replay.status, 200); assert.equal(replay.etag, first.etag); assert.deepEqual(replay.body, first.body);
    const events = await prisma.auditEvent.findMany({ where: { requestId: "order-replay-request" } }); assert.equal(events.length, 1); assert.equal(events[0]?.idempotencyKeyFingerprint, fingerprintIdempotencyKey(key));
    const beforeLegacy = await request(server, "a", `/orders/${seeded.orderId}`);
    const legacyAddress = server.address();
    if (legacyAddress === null || typeof legacyAddress === "string") throw new Error("missing legacy server address");
    const legacyResponse = await fetch(`http://127.0.0.1:${legacyAddress.port}/api/orders/${seeded.orderId}`, { method: "PATCH", headers: { authorization: "Bearer a", "content-type": "application/json" }, body: JSON.stringify({ notes: "legacy" }) }); assert.equal(legacyResponse.status, 200);
    const staleLegacy = await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: { "if-match": beforeLegacy.etag! }, body: JSON.stringify({ notes: "stale" }) }); assert.equal(staleLegacy.status, 412);
    const beforeItem = await request(server, "a", `/orders/${seeded.orderId}`); await prisma.orderItem.update({ where: { id: seeded.itemId }, data: { quantity: 2 } });
    assert.equal((await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: { "if-match": beforeItem.etag! }, body: JSON.stringify({ notes: "stale item" }) })).status, 412);
    const beforeComment = await request(server, "a", `/orders/${seeded.orderId}`); await prisma.orderComment.create({ data: { orderId: seeded.orderId, author: "direct", body: "comment" } });
    assert.equal((await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: { "if-match": beforeComment.etag! }, body: JSON.stringify({ notes: "stale comment" }) })).status, 412);
    const beforeInvoice = await request(server, "a", `/orders/${seeded.orderId}`); await invoices.createInvoiceForOrder(tenantA, seeded.orderId, { metadata: audit(principals.a, "invoice-transition") });
    assert.equal((await request(server, "a", `/orders/${seeded.orderId}`, { method: "PATCH", headers: { "if-match": beforeInvoice.etag! }, body: JSON.stringify({ notes: "stale invoice" }) })).status, 412);
  } finally { await close(server); await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
