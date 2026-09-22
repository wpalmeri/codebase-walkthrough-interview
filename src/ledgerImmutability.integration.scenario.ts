import assert from "node:assert/strict";
import { prisma } from "./db";

interface NamedRow {
  readonly name: string;
}

async function main(): Promise<void> {
  const migrations = await prisma.$queryRaw<NamedRow[]>`
    SELECT migration_name AS name
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL
    ORDER BY migration_name
  `;
  assert.equal(
    migrations.some(({ name }) => name === "20260922070000_ledger_immutability_guards"),
    true,
    "fresh migration deploy must install ledger immutability guards"
  );

  await prisma.customer.createMany({
    data: [
      { id: "ledger-customer-a", name: "Customer A", email: "a@example.com" },
      { id: "ledger-customer-b", name: "Customer B", email: "b@example.com" },
    ],
  });
  await prisma.product.createMany({
    data: [
      { id: "ledger-product-a", sku: "LEDGER-A", name: "Product A", unit: "seat", listPrice: 10 },
      { id: "ledger-product-b", sku: "LEDGER-B", name: "Product B", unit: "seat", listPrice: 20 },
    ],
  });
  await prisma.rate.createMany({
    data: [
      { id: "ledger-rate-a", customerId: "ledger-customer-a", productId: "ledger-product-a", unitPrice: 10 },
      { id: "ledger-rate-b", customerId: "ledger-customer-a", productId: "ledger-product-b", unitPrice: 20 },
    ],
  });
  await prisma.order.create({
    data: { id: "ledger-order-a", customerId: "ledger-customer-a", currencyCode: "USD" },
  });
  await prisma.order.create({
    data: { id: "ledger-order-b", customerId: "ledger-customer-a", currencyCode: "USD" },
  });
  await prisma.orderItem.create({
    data: {
      id: "ledger-item-a",
      orderId: "ledger-order-a",
      productId: "ledger-product-a",
      rateId: "ledger-rate-a",
      quantity: 1,
      unitPrice: 10,
      pricingCapturedAt: new Date("2026-09-22T00:00:00.000Z"),
    },
  });

  await assert.rejects(
    prisma.$executeRaw`UPDATE "OrderItem" SET "productId" = 'ledger-product-b' WHERE "id" = 'ledger-item-a'`,
    /captured OrderItem provenance is immutable/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "OrderItem" SET "rateId" = 'ledger-rate-b' WHERE "id" = 'ledger-item-a'`,
    /captured OrderItem provenance is immutable/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "OrderItem" SET "orderId" = 'ledger-order-b' WHERE "id" = 'ledger-item-a'`,
    /captured OrderItem provenance is immutable/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Order" SET "customerId" = 'ledger-customer-b' WHERE "id" = 'ledger-order-a'`,
    /orders with captured items have immutable customer and currency/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Order" SET "currencyCode" = NULL WHERE "id" = 'ledger-order-a'`,
    /orders with captured items have immutable customer and currency/u
  );

  await prisma.payment.create({
    data: {
      id: "ledger-payment-a",
      customerId: "ledger-customer-a",
      amount: 10,
      reference: "receipt-a",
    },
  });
  await assert.doesNotReject(
    prisma.$executeRaw`UPDATE "Payment" SET "amountDecimal" = 10.0000, "currencyCode" = 'USD' WHERE "id" = 'ledger-payment-a'`
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Payment" SET "amountDecimal" = 11.0000 WHERE "id" = 'ledger-payment-a'`,
    /Payment financial receipt fields are immutable after capture/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Payment" SET "amount" = 11.0000 WHERE "id" = 'ledger-payment-a'`,
    /Payment financial receipt fields are immutable after capture/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Payment" SET "reference" = 'corrected-receipt' WHERE "id" = 'ledger-payment-a'`,
    /Payment financial receipt fields are immutable after capture/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Payment" SET "customerId" = 'ledger-customer-b' WHERE "id" = 'ledger-payment-a'`,
    /Payment financial receipt fields are immutable after capture/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Payment" SET "receivedAt" = '2026-09-23 00:00:00' WHERE "id" = 'ledger-payment-a'`,
    /Payment financial receipt fields are immutable after capture/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "Payment" SET "currencyCode" = NULL WHERE "id" = 'ledger-payment-a'`,
    /Payment financial receipt fields are immutable after capture/u
  );
  await assert.rejects(
    prisma.$executeRaw`DELETE FROM "Payment" WHERE "id" = 'ledger-payment-a'`,
    /Payment is append-only and cannot be deleted/u
  );

  await prisma.invoice.create({
    data: {
      id: "ledger-invoice-a",
      number: "LEDGER-INV-A",
      customerId: "ledger-customer-a",
      orderId: "ledger-order-a",
      dueDate: new Date("2026-10-22T00:00:00.000Z"),
      currencyCode: "USD",
    },
  });
  await prisma.invoice.create({
    data: {
      id: "ledger-invoice-b",
      number: "LEDGER-INV-B",
      customerId: "ledger-customer-a",
      orderId: "ledger-order-b",
      dueDate: new Date("2026-10-22T00:00:00.000Z"),
      currencyCode: "USD",
    },
  });
  await prisma.paymentApplication.create({
    data: {
      id: "ledger-application-a",
      paymentId: "ledger-payment-a",
      invoiceId: "ledger-invoice-a",
      amount: 10,
    },
  });
  await assert.doesNotReject(
    prisma.$executeRaw`UPDATE "PaymentApplication" SET "amountDecimal" = 10.0000 WHERE "id" = 'ledger-application-a'`
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "PaymentApplication" SET "amountDecimal" = 9.0000 WHERE "id" = 'ledger-application-a'`,
    /PaymentApplication is append-only/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "PaymentApplication" SET "amount" = 9.0000 WHERE "id" = 'ledger-application-a'`,
    /PaymentApplication is append-only/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "PaymentApplication" SET "invoiceId" = 'ledger-invoice-b' WHERE "id" = 'ledger-application-a'`,
    /PaymentApplication is append-only/u
  );
  await assert.rejects(
    prisma.$executeRaw`UPDATE "PaymentApplication" SET "appliedAt" = '2026-09-23 00:00:00' WHERE "id" = 'ledger-application-a'`,
    /PaymentApplication is append-only/u
  );
  await assert.rejects(
    prisma.$executeRaw`DELETE FROM "PaymentApplication" WHERE "id" = 'ledger-application-a'`,
    /PaymentApplication is append-only and cannot be deleted/u
  );

  const triggerNames = await prisma.$queryRaw<NamedRow[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger'
      AND (name LIKE '%immutability%' OR name LIKE '%append_only%')
  `;
  const installed = new Set(triggerNames.map(({ name }) => name));
  for (const name of [
    "OrderItem_captured_provenance_immutability_guard",
    "Order_captured_item_commercial_identity_immutability_guard",
    "Payment_financial_receipt_immutability_guard",
    "Payment_append_only_delete_guard",
    "PaymentApplication_append_only_update_guard",
    "PaymentApplication_append_only_delete_guard",
  ]) {
    assert.equal(installed.has(name), true, `missing ${name}`);
  }
}

void main().finally(() => prisma.$disconnect());
