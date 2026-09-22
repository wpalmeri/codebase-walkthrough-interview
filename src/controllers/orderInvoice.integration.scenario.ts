import assert from "node:assert/strict";
import { prisma } from "../db";
import { appendRequestAuditEvent, type RequestAuditMetadata } from "../audit/requestAudit";
import * as invoices from "./invoiceController";
import * as orders from "./orderController";

function audit(requestId: string): RequestAuditMetadata {
  return {
    tenantId: "tenant-order-invoice",
    principal: {
      kind: "DEVELOPMENT",
      subjectId: "order-invoice-integration",
      credentialId: "order-invoice-integration",
    },
    requestId,
  };
}

function invoiceAudit(requestId: string): invoices.InvoiceMutationAudit {
  return { metadata: audit(requestId) };
}

async function auditEventForRequest(requestId: string) {
  return prisma.auditEvent.findFirst({
    where: { requestId },
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
}

async function main(): Promise<void> {
  try {
  const tenant = await prisma.tenant.create({
    data: { id: "tenant-order-invoice", slug: "order-invoice", name: "Order Invoice" },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      name: "Snapshot Customer",
      email: "billing@example.com",
      billingAddress: "1 Original Way",
    },
  });
  const seat = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      sku: "SEAT",
      name: "Captured Seat",
      unit: "seat",
      listPrice: 10,
      listPriceDecimal: "10.0000",
      currencyCode: "USD",
    },
  });
  const storage = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      sku: "STORAGE",
      name: "Captured Storage",
      unit: "GB",
      listPrice: 5,
      listPriceDecimal: "5.0000",
      currencyCode: "USD",
    },
  });
  const seatRate = await prisma.rate.create({
    data: {
      customerId: customer.id,
      productId: seat.id,
      unitPrice: 10,
      unitPriceDecimal: "10.0000",
      currencyCode: "USD",
    },
  });
  const storageRate = await prisma.rate.create({
    data: {
      customerId: customer.id,
      productId: storage.id,
      unitPrice: 5,
      unitPriceDecimal: "5.0000",
      currencyCode: "USD",
    },
  });
  const combo = await prisma.comboDiscount.create({
    data: {
      tenantId: tenant.id,
      name: "Captured bundle",
      percentOff: 10,
      percentOffDecimal: "10.0000",
      products: { connect: [{ id: seat.id }, { id: storage.id }] },
    },
  });

  const created = await orders.createOrder(tenant.id, {
    customerId: customer.id,
    items: [
      { productId: seat.id, quantity: 2 },
      { productId: storage.id, quantity: 1 },
    ],
  }, audit("order-invoice-create-1"));
  assert.equal(created.totalDecimal, "22.5000");
  assert.deepEqual(await auditEventForRequest("order-invoice-create-1"), {
    tenantId: tenant.id,
    action: "ORDER_CREATED",
    principalKind: "DEVELOPMENT",
    principalSubject: "order-invoice-integration",
    principalCredentialId: "order-invoice-integration",
    requestId: "order-invoice-create-1",
    idempotencyKeyFingerprint: null,
    resourceKind: "ORDER",
    resourceId: created.id,
  });
  assert.deepEqual(
    created.items
      .map((item) => [item.productName, item.amountDecimal])
      .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    [
      ["Captured Seat", "18.0000"],
      ["Captured Storage", "4.5000"],
    ]
  );

  await prisma.product.update({
    where: { id: seat.id },
    data: { name: "Changed Live Seat", listPrice: 999, listPriceDecimal: "999.0000" },
  });
  await prisma.rate.update({
    where: { id: seatRate.id },
    data: { unitPrice: 999, unitPriceDecimal: "999.0000" },
  });
  await prisma.rate.update({
    where: { id: storageRate.id },
    data: { unitPrice: 888, unitPriceDecimal: "888.0000" },
  });
  await prisma.comboDiscount.update({
    where: { id: combo.id },
    data: { name: "Changed live bundle", percentOff: 99, percentOffDecimal: "99.0000" },
  });

  const unchanged = await orders.getOrder(tenant.id, created.id);
  assert.equal(unchanged.totalDecimal, "22.5000");
  assert.equal(
    unchanged.items.find((item) => item.productId === seat.id)?.productName,
    "Captured Seat"
  );

  const draft = await invoices.createInvoiceForOrder(
    tenant.id,
    created.id,
    invoiceAudit("order-invoice-invoice-1")
  );
  assert.equal(draft.status, "DRAFT");
  assert.equal(draft.totalDecimal, "22.5000");
  assert.equal(
    draft.lines.find((line) => line.description.startsWith("Captured Seat"))?.description,
    "Captured Seat @ seat"
  );

  const seatItem = created.items.find((item) => item.productId === seat.id);
  assert.ok(seatItem);
  const repriced = await orders.saveOrder(tenant.id, created.id, {
    items: [{ id: seatItem.id, quantity: 3 }],
  }, audit("order-invoice-update-1"));
  assert.equal(repriced.totalDecimal, "31.5000");
  assert.deepEqual(await auditEventForRequest("order-invoice-update-1"), {
    tenantId: tenant.id,
    action: "ORDER_UPDATED",
    principalKind: "DEVELOPMENT",
    principalSubject: "order-invoice-integration",
    principalCredentialId: "order-invoice-integration",
    requestId: "order-invoice-update-1",
    idempotencyKeyFingerprint: null,
    resourceKind: "ORDER",
    resourceId: created.id,
  });
  const synchronizedDraft = await invoices.getInvoice(tenant.id, draft.id);
  assert.equal(synchronizedDraft.totalDecimal, "31.5000");
  assert.equal(
    synchronizedDraft.lines.find((line) => line.description.startsWith("Captured Seat"))
      ?.amountDecimal,
    "27.0000"
  );

  const posted = await invoices.postInvoice(tenant.id, draft.id, invoiceAudit("order-invoice-post-1"));
  assert.equal(posted.status, "POSTED");
  assert.equal(posted.totalDecimal, "31.5000");
  assert.match(posted.accountingDate ?? "", /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(posted.customerName, "Snapshot Customer");
  const postedLineIds = posted.lines.map((line) => line.id).toSorted();

  const postedAgain = await invoices.postInvoice(tenant.id, draft.id, invoiceAudit("order-invoice-post-replay"));
  assert.equal(postedAgain.postedAt, posted.postedAt);
  assert.deepEqual(
    postedAgain.lines.map((line) => line.id).toSorted(),
    postedLineIds
  );
  const auditCountBeforeFinalizedUpdate = await prisma.auditEvent.count();
  await assert.rejects(
    orders.saveOrder(
      tenant.id,
      created.id,
      { items: [{ id: seatItem.id, quantity: 4 }] },
      audit("order-invoice-finalized-failure")
    ),
    /finalized invoices cannot be changed/
  );
  assert.equal(await prisma.auditEvent.count(), auditCountBeforeFinalizedUpdate);
  assert.equal((await invoices.getInvoice(tenant.id, draft.id)).totalDecimal, "31.5000");

  const closedOrder = await orders.createOrder(tenant.id, {
    customerId: customer.id,
    items: [{ productId: seat.id, quantity: 1 }],
  }, audit("order-invoice-create-2"));
  const closedDraft = await invoices.createInvoiceForOrder(
    tenant.id,
    closedOrder.id,
    invoiceAudit("order-invoice-invoice-2")
  );
  assert.ok(closedDraft.accountingDate);
  await prisma.tenantAccountingPeriodControl.create({
    data: { tenantId: tenant.id, closedThroughDate: closedDraft.accountingDate },
  });
  await assert.rejects(
    invoices.postInvoice(tenant.id, closedDraft.id, invoiceAudit("order-invoice-post-closed")),
    /Accounting date .* is closed through/
  );
  await assert.rejects(
    invoices.updateInvoice(tenant.id, closedDraft.id, {
      issueDate: `${closedDraft.accountingDate}T12:00:00.000Z`,
    }, invoiceAudit("order-invoice-update-closed")),
    /Accounting date .* is closed through/
  );
  // The tenant-scoped controller is the authority during the nullable ownership
  // rollout; the legacy singleton database guard remains for legacy rows.
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: closedDraft.id } })).status, "DRAFT");

  const orderCountBeforeAuditFailure = await prisma.order.count({ where: { tenantId: tenant.id } });
  const existingAuditId = (await prisma.auditEvent.findFirstOrThrow({ select: { id: true } })).id;
  await assert.rejects(
    orders.createOrder(
      tenant.id,
      { customerId: customer.id, items: [{ productId: seat.id, quantity: 1 }] },
      audit("order-invoice-audit-failure"),
      (repository, metadata, event) =>
        appendRequestAuditEvent(repository, metadata, event, {
          createId: () => existingAuditId,
          now: () => new Date("2026-09-22T16:00:00.000Z"),
        })
    ),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
  );
  assert.equal(await prisma.order.count({ where: { tenantId: tenant.id } }), orderCountBeforeAuditFailure);
  assert.equal(await auditEventForRequest("order-invoice-audit-failure"), null);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
