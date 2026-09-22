import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import { appendRequestAuditEvent, type RequestAuditMetadata } from "../audit/requestAudit";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";
import { createInvoiceForOrder, updateInvoice, type InvoiceMutationAudit } from "./invoiceController";
import { createOrder } from "./orderController";

const tenantA = "invoice-audit-tenant-a";
const tenantB = "invoice-audit-tenant-b";
const customerA = "invoice-audit-customer-a";
const customerB = "invoice-audit-customer-b";

const principals: Record<string, Principal> = {
  "invoice-audit-key-a": {
    tenantId: tenantA,
    subjectId: "service:invoice-audit-a",
    credentialId: "credential-invoice-audit-a",
    kind: "TENANT_API_KEY",
    role: "BILLING",
  },
  "invoice-audit-key-b": {
    tenantId: tenantB,
    subjectId: "service:invoice-audit-b",
    credentialId: "credential-invoice-audit-b",
    kind: "TENANT_API_KEY",
    role: "BILLING",
  },
};

type ApiResponse = { readonly status: number; readonly body: unknown };

async function request(
  server: Server,
  token: keyof typeof principals,
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
  headers: Record<string, string>
): Promise<ApiResponse> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("invoice audit server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function failingAudit(): InvoiceMutationAudit {
  return {
    metadata: {
      tenantId: tenantA,
      principal: {
        kind: "DEVELOPMENT",
        subjectId: "integration:invoice-audit-failure",
        credentialId: "integration-invoice-audit-failure",
      },
      requestId: "invoice-audit-forced-failure",
    },
    append: async () => {
      throw new Error("forced invoice audit persistence failure");
    },
  };
}

function auditMetadata(requestId: string): RequestAuditMetadata {
  return {
    tenantId: tenantA,
    principal: {
      kind: "DEVELOPMENT",
      subjectId: "integration:invoice-audit",
      credentialId: "integration-invoice-audit",
    },
    requestId,
  };
}

async function seedInvoice(input: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly suffix: string;
}): Promise<string> {
  const orderId = `invoice-audit-order-${input.suffix}`;
  const invoiceId = `invoice-audit-invoice-${input.suffix}`;
  await prisma.order.create({
    data: { id: orderId, tenantId: input.tenantId, customerId: input.customerId, currencyCode: "USD" },
  });
  await prisma.invoice.create({
    data: {
      id: invoiceId,
      tenantId: input.tenantId,
      number: `INVOICE-AUDIT-${input.suffix}`,
      customerId: input.customerId,
      orderId,
      status: "DRAFT",
      dueDate: new Date("2026-10-31T00:00:00.000Z"),
      total: 10,
      totalDecimal: "10.0000",
      amountPaid: 0,
      amountPaidDecimal: "0.0000",
      currencyCode: "USD",
      accountingDate: "2026-09-22",
      lines: {
        create: {
          description: "Audit service",
          quantity: 1,
          quantityDecimal: "1.000000",
          unitPrice: 10,
          unitPriceDecimal: "10.0000",
          amount: 10,
          amountDecimal: "10.0000",
        },
      },
    },
  });
  return invoiceId;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function main(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Invoice Audit Tenant A" },
      { id: tenantB, slug: tenantB, name: "Invoice Audit Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: customerA, tenantId: tenantA, name: "Invoice Audit Customer A", email: "invoice-a@example.com", portalAccount: "portal-audit-a" },
      { id: customerB, tenantId: tenantB, name: "Invoice Audit Customer B", email: "invoice-b@example.com", portalAccount: "portal-audit-b" },
    ],
  });
  const invoiceId = await seedInvoice({ tenantId: tenantA, customerId: customerA, suffix: "main" });
  await seedInvoice({ tenantId: tenantB, customerId: customerB, suffix: "foreign" });
  const app = createApp({ principalResolver: { resolve: async (token) => principals[token] ?? null } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const updateKey = "invoice-audit-update-key";
    const updateHeaders = {
      "x-request-id": "invoice-audit-request-update",
      "idempotency-key": updateKey,
      "idempotency-client": "invoice-audit-integration",
    };
    const updated = await request(
      server,
      "invoice-audit-key-a",
      `/invoices/${invoiceId}`,
      "PATCH",
      { dueDate: "2026-11-01T00:00:00.000Z" },
      updateHeaders
    );
    assert.equal(updated.status, 200);
    const replay = await request(
      server,
      "invoice-audit-key-a",
      `/invoices/${invoiceId}`,
      "PATCH",
      { dueDate: "2026-11-01T00:00:00.000Z" },
      { ...updateHeaders, "x-request-id": "invoice-audit-request-update-replay" }
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, updated.body);

    const posted = await request(
      server, "invoice-audit-key-a", `/invoices/${invoiceId}/post`, "POST", undefined,
      { "x-request-id": "invoice-audit-request-post" }
    );
    assert.equal(posted.status, 200);
    const postedReplay = await request(
      server, "invoice-audit-key-a", `/invoices/${invoiceId}/post`, "POST", undefined,
      { "x-request-id": "invoice-audit-request-post-replay" }
    );
    assert.equal(postedReplay.status, 200);
    assert.deepEqual(postedReplay.body, posted.body);
    const sent = await request(
      server, "invoice-audit-key-a", `/invoices/${invoiceId}/send`, "POST", { method: "PORTAL" },
      { "x-request-id": "invoice-audit-request-send" }
    );
    assert.equal(sent.status, 200);
    const transmission = await prisma.transmission.findFirstOrThrow({ where: { invoiceId } });
    await prisma.transmission.update({
      where: { id: transmission.id },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });
    const refreshed = await request(
      server, "invoice-audit-key-a", `/invoices/transmissions/${transmission.id}/refresh`, "POST", undefined,
      { "x-request-id": "invoice-audit-request-refresh" }
    );
    assert.equal(refreshed.status, 200);
    const auditAfterRefresh = await prisma.auditEvent.count();
    const unchangedRefresh = await request(
      server, "invoice-audit-key-a", `/invoices/transmissions/${transmission.id}/refresh`, "POST", undefined,
      { "x-request-id": "invoice-audit-request-refresh-unchanged" }
    );
    assert.equal(unchangedRefresh.status, 200);
    assert.equal(
      await prisma.auditEvent.count(),
      auditAfterRefresh,
      "a refresh that observes no lifecycle change must not append a mutation event"
    );

    const auditBeforeFailures = await prisma.auditEvent.count();
    const foreign = await request(
      server, "invoice-audit-key-b", `/invoices/${invoiceId}`, "PATCH", { dueDate: "2026-11-02T00:00:00.000Z" },
      { "x-request-id": "invoice-audit-request-foreign" }
    );
    assert.equal(foreign.status, 404);
    const validation = await request(
      server, "invoice-audit-key-a", `/invoices/${invoiceId}`, "PATCH", { dueDate: "not-a-date" },
      { "x-request-id": "invoice-audit-request-validation" }
    );
    assert.equal(validation.status, 400);
    assert.equal(await prisma.auditEvent.count(), auditBeforeFailures);

    const events = await prisma.auditEvent.findMany({ orderBy: { occurredAt: "asc" } });
    assert.equal(events.length, 5, "replay, foreign, and validation failures must not append evidence");
    const updateEvent = events.find(({ action }) => action === "INVOICE_UPDATED");
    const postEvent = events.find(({ action }) => action === "INVOICE_POSTED");
    const sentEvent = events.find(({ action }) => action === "INVOICE_SENT");
    const sendEvent = events.find(({ action }) => action === "INVOICE_DELIVERY_REQUESTED");
    const refreshEvent = events.find(({ action }) => action === "INVOICE_DELIVERY_UPDATED");
    assert.deepEqual(updateEvent, {
      id: updateEvent?.id,
      tenantId: tenantA,
      action: "INVOICE_UPDATED",
      principalKind: "TENANT_API_KEY",
      principalSubject: principals["invoice-audit-key-a"].subjectId,
      principalCredentialId: principals["invoice-audit-key-a"].credentialId,
      requestId: "invoice-audit-request-update",
      idempotencyKeyFingerprint: fingerprintIdempotencyKey(updateKey),
      resourceKind: "INVOICE",
      resourceId: invoiceId,
      occurredAt: updateEvent?.occurredAt,
    });
    assert.equal(postEvent?.resourceId, invoiceId);
    assert.equal(postEvent?.requestId, "invoice-audit-request-post");
    assert.equal(sentEvent?.resourceId, invoiceId);
    assert.equal(sentEvent?.requestId, "invoice-audit-request-send");
    assert.equal(sendEvent?.resourceKind, "INVOICE_DELIVERY");
    assert.equal(sendEvent?.resourceId, transmission.id);
    assert.equal(refreshEvent?.resourceId, transmission.id);
    assert.equal(JSON.stringify(events).includes(updateKey), false);

    const failureInvoiceId = await seedInvoice({ tenantId: tenantA, customerId: customerA, suffix: "failure" });
    const dueDateBeforeFailure = await prisma.invoice.findUniqueOrThrow({ where: { id: failureInvoiceId } });
    await assert.rejects(
      updateInvoice(tenantA, failureInvoiceId, { dueDate: "2026-12-01T00:00:00.000Z" }, failingAudit()),
      /forced invoice audit persistence failure/u
    );
    const dueDateAfterFailure = await prisma.invoice.findUniqueOrThrow({ where: { id: failureInvoiceId } });
    assert.equal(dueDateAfterFailure.dueDate.toISOString(), dueDateBeforeFailure.dueDate.toISOString());
    assert.equal(await prisma.auditEvent.count(), auditBeforeFailures);

    const product = await prisma.product.create({
      data: {
        tenantId: tenantA,
        sku: "INVOICE-AUDIT-CREATION-PRODUCT",
        name: "Invoice audit service",
        unit: "month",
        listPrice: 10,
        listPriceDecimal: "10.0000",
        currencyCode: "USD",
      },
    });
    await prisma.rate.create({
      data: {
        customerId: customerA,
        productId: product.id,
        unitPrice: 10,
        unitPriceDecimal: "10.0000",
        currencyCode: "USD",
      },
    });
    const order = await createOrder(
      tenantA,
      { customerId: customerA, items: [{ productId: product.id, quantity: 1 }] },
      auditMetadata("invoice-audit-order-created")
    );
    const createdInvoice = await createInvoiceForOrder(tenantA, order.id, {
      metadata: auditMetadata("invoice-audit-invoice-created"),
    });
    const creationEvents = await prisma.auditEvent.findMany({
      where: { requestId: "invoice-audit-invoice-created" },
      orderBy: { action: "asc" },
      select: {
        tenantId: true,
        action: true,
        principalKind: true,
        principalSubject: true,
        principalCredentialId: true,
        requestId: true,
        idempotencyKeyFingerprint: true,
        resourceKind: true,
        resourceId: true,
      },
    });
    assert.deepEqual(creationEvents, [
      {
        tenantId: tenantA,
        action: "INVOICE_CREATED",
        principalKind: "DEVELOPMENT",
        principalSubject: "integration:invoice-audit",
        principalCredentialId: "integration-invoice-audit",
        requestId: "invoice-audit-invoice-created",
        idempotencyKeyFingerprint: null,
        resourceKind: "INVOICE",
        resourceId: createdInvoice.id,
      },
      {
        tenantId: tenantA,
        action: "ORDER_INVOICED",
        principalKind: "DEVELOPMENT",
        principalSubject: "integration:invoice-audit",
        principalCredentialId: "integration-invoice-audit",
        requestId: "invoice-audit-invoice-created",
        idempotencyKeyFingerprint: null,
        resourceKind: "ORDER",
        resourceId: order.id,
      },
    ]);

    const failureOrder = await createOrder(
      tenantA,
      { customerId: customerA, items: [{ productId: product.id, quantity: 1 }] },
      auditMetadata("invoice-audit-order-failure")
    );
    let appendCalls = 0;
    const creationFailureAudit: InvoiceMutationAudit = {
      metadata: auditMetadata("invoice-audit-creation-forced-failure"),
      append: async (repository, metadata, event) => {
        appendCalls += 1;
        if (appendCalls === 2) throw new Error("forced second invoice audit persistence failure");
        return appendRequestAuditEvent(repository, metadata, event);
      },
    };
    await assert.rejects(
      createInvoiceForOrder(tenantA, failureOrder.id, creationFailureAudit),
      /forced second invoice audit persistence failure/u
    );
    assert.equal(await prisma.invoice.count({ where: { orderId: failureOrder.id } }), 0);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: failureOrder.id } })).status, "OPEN");
    assert.equal(
      await prisma.auditEvent.count({ where: { requestId: "invoice-audit-creation-forced-failure" } }),
      0,
      "the first audit append and all invoice changes must roll back when the second event fails"
    );
  } finally {
    await close(server);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
