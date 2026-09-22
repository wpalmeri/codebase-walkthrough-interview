import assert from "node:assert/strict";
import { once } from "node:events";
import { CustomerRevenueSchema } from "@meridian/contracts";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";

const principal: Principal = { subjectId: "reports", credentialId: "reports", kind: "OPERATOR_API_KEY", role: "VIEWER" };
async function seedInvoice(customerName: string, amount: string) {
  const customer = await prisma.customer.create({ data: { name: customerName, email: `${customerName.replaceAll(" ", ".").toLowerCase()}@example.com` } });
  const order = await prisma.order.create({ data: { customerId: customer.id, status: "INVOICED" } });
  await prisma.invoice.create({ data: { number: `REPORT-${customer.id}`, customerId: customer.id, orderId: order.id, status: "POSTED", dueDate: new Date("2026-02-01T00:00:00.000Z"), issueDate: new Date("2026-01-01T00:00:00.000Z"), accountingDate: "2026-01-01", total: Number(amount), totalDecimal: amount, currencyCode: "USD" } });
  return customer;
}
async function main(): Promise<void> {
  try {
    const [a, b] = await Promise.all([seedInvoice("Report A", "1.2500"), seedInvoice("Report B", "2.5000")]);
    const app = createApp({ principalResolver: { resolve: async () => principal } }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("server has no TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/reports/revenue-by-customer?from=2026-01-01&to=2026-01-31`, { headers: { authorization: "Bearer operator" } });
      assert.equal(response.status, 200); const rows = CustomerRevenueSchema.array().parse(await response.json()); assert.deepEqual(rows.map((row) => row.customerId).toSorted(), [a.id, b.id].toSorted()); assert.equal(rows.reduce((sum, row) => sum + Number(row.revenueDecimal), 0), 3.75);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
