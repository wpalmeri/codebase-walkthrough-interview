import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../app";
import type { RequestAuditMetadata } from "../audit/requestAudit";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";
import { DomainInvariantError } from "../errors";
import * as invoices from "./invoiceController";
import * as orders from "./orderController";

const billingPrincipal: Principal = {
  subjectId: "orders-billing", credentialId: "orders-billing-key", kind: "OPERATOR_API_KEY", role: "BILLING",
};
const viewerPrincipal: Principal = { ...billingPrincipal, credentialId: "orders-viewer-key", role: "VIEWER" };

function audit(requestId: string): RequestAuditMetadata {
  return { principal: { kind: "OPERATOR_API_KEY", subjectId: billingPrincipal.subjectId, credentialId: billingPrincipal.credentialId }, requestId };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function main(): Promise<void> {
  try {
    const [customerA, customerB] = await Promise.all([
      prisma.customer.create({ data: { id: "order-customer-a", name: "Customer A", email: "a@example.com" } }),
      prisma.customer.create({ data: { id: "order-customer-b", name: "Customer B", email: "b@example.com" } }),
    ]);
    const product = await prisma.product.create({
      data: { id: "order-global-product", sku: "ORDER-GLOBAL", name: "Global product", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" },
    });
    await prisma.rate.create({
      data: { customerId: customerA.id, productId: product.id, unitPrice: 8, unitPriceDecimal: "8.0000", currencyCode: "USD" },
    });

    const order = await orders.createOrder(
      { customerId: customerA.id, items: [{ productId: product.id, quantity: 2 }] },
      audit("create-order")
    );
    assert.equal(order.customerId, customerA.id);
    assert.equal(order.items[0]?.baseUnitPriceDecimal, "8.0000");
    const invoice = await invoices.createInvoiceForOrder(order.id, { metadata: audit("create-invoice") });
    assert.equal(invoice.customerId, customerA.id);
    assert.equal(invoice.totalDecimal, "16.0000");
    await assert.rejects(
      orders.saveOrder(order.id, { customerId: customerB.id }, audit("change-customer")),
      (error) => {
        assert.ok(error instanceof DomainInvariantError);
        assert.equal(error.problem.code, "ORDER_CUSTOMER_IMMUTABLE");
        return true;
      }
    );

    const app = createApp({
      environment: "production",
      principalResolver: { resolve: async (token) => token === "billing" ? billingPrincipal : token === "viewer" ? viewerPrincipal : null },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
      const request = async (token: string, path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        if (init.body !== undefined) headers.set("content-type", "application/json");
        return fetch(`http://127.0.0.1:${address.port}/api${path}`, { ...init, headers });
      };
      const listed = await request("viewer", "/orders");
      assert.equal(listed.status, 200);
      const body = await listed.json();
      assert.ok(Array.isArray(body));
      assert.ok(body.some((entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === order.id));
      const denied = await request("viewer", "/orders", {
        method: "POST",
        body: JSON.stringify({ customerId: customerA.id, items: [{ productId: product.id, quantity: 1 }] }),
      });
      assert.equal(denied.status, 403);
    } finally {
      await close(server);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
