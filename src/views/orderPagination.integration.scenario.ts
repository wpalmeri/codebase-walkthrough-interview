import assert from "node:assert/strict";
import { once } from "node:events";
import { OrderPageSchema } from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principal: Principal = { subjectId: "order-page", credentialId: "order-page", kind: "OPERATOR_API_KEY", role: "VIEWER" };
async function main(): Promise<void> {
  try {
    const customer = await prisma.customer.create({ data: { name: "Order page customer", email: "order-page@example.com" } });
    await prisma.order.createMany({ data: [
      { id: "order-page-1", customerId: customer.id, orderDate: new Date("2026-01-03T00:00:00.000Z") },
      { id: "order-page-2", customerId: customer.id, orderDate: new Date("2026-01-02T00:00:00.000Z") },
      { id: "order-page-3", customerId: customer.id, orderDate: new Date("2026-01-01T00:00:00.000Z") },
    ] });
    const app = createApp({ principalResolver: { resolve: async () => principal } }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("server has no TCP address"); const headers = { authorization: "Bearer operator" };
      const firstResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/orders?limit=2`, { headers }); const first = OrderPageSchema.parse(await firstResponse.json()); assert.deepEqual(first.data.map((order) => order.id), ["order-page-1", "order-page-2"]);
      const secondResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/orders?limit=2&cursor=${encodeURIComponent(first.page.nextCursor ?? "")}`, { headers }); const second = OrderPageSchema.parse(await secondResponse.json()); assert.deepEqual(second.data.map((order) => order.id), ["order-page-3"]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
