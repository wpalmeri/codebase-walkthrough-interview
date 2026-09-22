import assert from "node:assert/strict";
import { once } from "node:events";
import { PaymentPageSchema } from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principal: Principal = { subjectId: "payment-page", credentialId: "payment-page", kind: "OPERATOR_API_KEY", role: "VIEWER" };
async function main(): Promise<void> {
  try {
    const [a, b] = await Promise.all([prisma.customer.create({ data: { name: "Payment page A", email: "payment-a@example.com" } }), prisma.customer.create({ data: { name: "Payment page B", email: "payment-b@example.com" } })]);
    await prisma.payment.createMany({ data: [
      { id: "payment-page-1", customerId: a.id, amount: 1, amountDecimal: "1.0000", currencyCode: "USD", receivedAt: new Date("2026-01-03T00:00:00.000Z") },
      { id: "payment-page-2", customerId: b.id, amount: 2, amountDecimal: "2.0000", currencyCode: "USD", receivedAt: new Date("2026-01-02T00:00:00.000Z") },
      { id: "payment-page-3", customerId: a.id, amount: 3, amountDecimal: "3.0000", currencyCode: "USD", receivedAt: new Date("2026-01-01T00:00:00.000Z") },
    ] });
    const app = createApp({ principalResolver: { resolve: async () => principal } }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("server has no TCP address"); const headers = { authorization: "Bearer operator" };
      const allResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/payments?limit=2`, { headers }); const all = PaymentPageSchema.parse(await allResponse.json()); assert.deepEqual(all.data.map((payment) => payment.id), ["payment-page-1", "payment-page-2"]);
      const customerResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/payments?customerId=${a.id}&limit=10`, { headers }); const customer = PaymentPageSchema.parse(await customerResponse.json()); assert.deepEqual(customer.data.map((payment) => payment.id), ["payment-page-1", "payment-page-3"]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
