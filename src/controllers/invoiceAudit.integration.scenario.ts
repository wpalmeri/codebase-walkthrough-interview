import assert from "node:assert/strict";
import { prisma } from "../db";
import * as invoices from "./invoiceController";
import * as orders from "./orderController";

const audit = (requestId: string) => ({
  principal: { kind: "DEVELOPMENT" as const, subjectId: "invoice-audit", credentialId: "invoice-audit" },
  requestId,
});

async function main(): Promise<void> {
  try {
    const customer = await prisma.customer.create({ data: { name: "Invoice audit customer", email: "audit@example.com" } });
    const product = await prisma.product.create({
      data: { sku: "INVOICE-AUDIT", name: "Invoice audit product", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" },
    });
    const order = await orders.createOrder({ customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] }, audit("invoice-audit-order"));
    const created = await invoices.createInvoiceForOrder(order.id, { metadata: audit("invoice-audit-created") });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { requestId: "invoice-audit-created" } });
    assert.equal(event.action, "INVOICE_CREATED");
    assert.equal(event.resourceId, created.id);

    const originalDueDate = created.dueDate;
    await assert.rejects(
      invoices.updateInvoice(created.id, { dueDate: "2026-12-31T00:00:00.000Z" }, {
        metadata: audit("invoice-audit-rollback"),
        append: async () => { throw new Error("audit persistence failed"); },
      }),
      /audit persistence failed/u
    );
    assert.equal((await invoices.getInvoice(created.id)).dueDate, originalDueDate);
    assert.equal(await prisma.auditEvent.count({ where: { requestId: "invoice-audit-rollback" } }), 0);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
