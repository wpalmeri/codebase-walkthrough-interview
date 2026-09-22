import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";
import * as invoices from "./invoiceController";
import * as orders from "./orderController";

const tenantA: Principal = {
  tenantId: "tenant-orders-a",
  subjectId: "tenant:orders-a",
  credentialId: "credential:orders-a",
  kind: "TENANT_API_KEY",
  role: "BILLING",
};
const tenantB: Principal = {
  tenantId: "tenant-orders-b",
  subjectId: "tenant:orders-b",
  credentialId: "credential:orders-b",
  kind: "TENANT_API_KEY",
  role: "BILLING",
};
const tenantAViewer: Principal = { ...tenantA, credentialId: "credential:orders-a-viewer", role: "VIEWER" };

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
}

function responseIds(body: unknown): string[] {
  assert.ok(Array.isArray(body));
  return body.map((value) => {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    const id = Object.getOwnPropertyDescriptor(value, "id")?.value;
    assert.equal(typeof id, "string");
    return id;
  });
}

async function main(): Promise<void> {
  try {
    await prisma.tenant.createMany({
      data: [
        { id: tenantA.tenantId, slug: "orders-a", name: "Orders A" },
        { id: tenantB.tenantId, slug: "orders-b", name: "Orders B" },
      ],
    });
    const [customerA, customerB] = await Promise.all([
      prisma.customer.create({ data: { tenantId: tenantA.tenantId, name: "A Customer", email: "a@example.com" } }),
      prisma.customer.create({ data: { tenantId: tenantB.tenantId, name: "B Customer", email: "b@example.com" } }),
    ]);
    const [productA, productB] = await Promise.all([
      prisma.product.create({
        data: { tenantId: tenantA.tenantId, sku: "tenant-order-product-a", name: "A Product", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" },
      }),
      prisma.product.create({
        data: { tenantId: tenantB.tenantId, sku: "tenant-order-product-b", name: "B Product", unit: "seat", listPrice: 10, listPriceDecimal: "10.0000", currencyCode: "USD" },
      }),
    ]);
    await Promise.all([
      prisma.rate.create({ data: { customerId: customerA.id, productId: productA.id, unitPrice: 10, unitPriceDecimal: "10.0000", currencyCode: "USD" } }),
      prisma.rate.create({ data: { customerId: customerB.id, productId: productB.id, unitPrice: 10, unitPriceDecimal: "10.0000", currencyCode: "USD" } }),
    ]);
    const [orderA, orderB] = await Promise.all([
      orders.createOrder(tenantA.tenantId, { customerId: customerA.id, items: [{ productId: productA.id, quantity: 1 }] }),
      orders.createOrder(tenantB.tenantId, { customerId: customerB.id, items: [{ productId: productB.id, quantity: 1 }] }),
    ]);
    const [invoiceA, invoiceB] = await Promise.all([
      invoices.createInvoiceForOrder(tenantA.tenantId, orderA.id),
      invoices.createInvoiceForOrder(tenantB.tenantId, orderB.id),
    ]);
    const transmissionA = await prisma.transmission.create({
      data: { invoiceId: invoiceA.id, method: "PORTAL", status: "QUEUED", detail: "queued for ownership test" },
    });

    assert.deepEqual((await orders.listOrders(tenantA.tenantId)).map((order) => order.id), [orderA.id]);
    assert.deepEqual((await invoices.listInvoices(tenantB.tenantId)).map((invoice) => invoice.id), [invoiceB.id]);

    const app = createApp({
      principalResolver: {
        async resolve(token) {
          return token === "tenant-a" ? tenantA : token === "tenant-b" ? tenantB : token === "tenant-a-viewer" ? tenantAViewer : null;
        },
      },
      logError() {
        throw new Error("tenant isolation errors must be public 4xx responses");
      },
    });
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    const request = async (token: string, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.method !== undefined && init.method !== "GET") headers.set("content-type", "application/json");
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers,
      });
      return { response, body: await response.json() };
    };
    const hidden = { type: "urn:meridian:problem:not-found", title: "Not Found", status: 404, code: "NOT_FOUND" };

    try {
      const listedA = await request("tenant-a", "/orders");
      assert.equal(listedA.response.status, 200);
      assert.deepEqual(responseIds(listedA.body), [orderA.id]);
      const listedInvoicesA = await request("tenant-a", "/invoices");
      assert.deepEqual(responseIds(listedInvoicesA.body), [invoiceA.id]);

      for (const path of [`/orders/${orderA.id}`, `/invoices/${invoiceA.id}`]) {
        const hiddenResponse = await request("tenant-b", path);
        assert.equal(hiddenResponse.response.status, 404);
        assert.deepEqual(hiddenResponse.body, hidden);
      }
      const originalNotes = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id }, select: { notes: true } });
      const originalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA.id }, select: { status: true, issueDate: true } });
      const originalCounts = {
        orders: await prisma.order.count(),
        invoices: await prisma.invoice.count(),
        transmissions: await prisma.transmission.count(),
      };

      const crossTenantRequests: Array<{ path: string; init: RequestInit }> = [
        { path: "/orders", init: { method: "POST", body: JSON.stringify({ customerId: customerA.id, items: [{ productId: productA.id, quantity: 1 }] }) } },
        { path: `/orders/${orderA.id}`, init: { method: "PATCH", body: JSON.stringify({ notes: "must not write" }) } },
        { path: `/orders/${orderA.id}/invoice`, init: { method: "POST" } },
        { path: `/invoices/${invoiceA.id}`, init: { method: "PATCH", body: JSON.stringify({ dueDate: "2030-01-02T00:00:00.000Z" }) } },
        { path: `/invoices/${invoiceA.id}/post`, init: { method: "POST" } },
        { path: `/invoices/${invoiceA.id}/send`, init: { method: "POST", body: JSON.stringify({ method: "EMAIL" }) } },
        { path: `/invoices/transmissions/${transmissionA.id}/refresh`, init: { method: "POST" } },
      ];
      for (const candidate of crossTenantRequests) {
        const denied = await request("tenant-b", candidate.path, candidate.init);
        assert.equal(denied.response.status, 404, candidate.path);
        assert.deepEqual(denied.body, hidden, candidate.path);
      }
      assert.deepEqual(
        { orders: await prisma.order.count(), invoices: await prisma.invoice.count(), transmissions: await prisma.transmission.count() },
        originalCounts
      );
      assert.deepEqual(
        await prisma.order.findUniqueOrThrow({ where: { id: orderA.id }, select: { notes: true } }),
        originalNotes
      );
      assert.deepEqual(
        await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA.id }, select: { status: true, issueDate: true } }),
        originalInvoice
      );
      assert.equal((await prisma.transmission.findUniqueOrThrow({ where: { id: transmissionA.id } })).status, "QUEUED");

      const viewerRead = await request("tenant-a-viewer", "/orders");
      assert.equal(viewerRead.response.status, 200);
      const viewerWrite = await request("tenant-a-viewer", "/orders", {
        method: "POST",
        body: JSON.stringify({ customerId: customerA.id, items: [{ productId: productA.id, quantity: 1 }] }),
      });
      assert.equal(viewerWrite.response.status, 403);
      assert.deepEqual(viewerWrite.body, {
        type: "urn:meridian:problem:forbidden",
        title: "Forbidden",
        status: 403,
        code: "FORBIDDEN",
      });
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
