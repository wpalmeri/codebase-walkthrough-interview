import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { runTenantContractPreflight } from "./tenantContractPreflight";

async function main(): Promise<void> {
  const clean = await runTenantContractPreflight();
  assert.deepEqual(clean, { state: "READY", ready: true, issues: [] });

  const [tenantA, tenantB] = await Promise.all([
    prisma.tenant.create({ data: { id: "preflight-tenant-a", slug: "preflight-tenant-a", name: "Preflight A" } }),
    prisma.tenant.create({ data: { id: "preflight-tenant-b", slug: "preflight-tenant-b", name: "Preflight B" } }),
  ]);
  const [customerA, customerB] = await Promise.all([
    prisma.customer.create({ data: { id: "preflight-customer-a", tenantId: tenantA.id, name: "Customer A", email: "a@example.test" } }),
    prisma.customer.create({ data: { id: "preflight-customer-b", tenantId: tenantB.id, name: "Customer B", email: "b@example.test" } }),
  ]);
  const [productA, productB] = await Promise.all([
    prisma.product.create({ data: { id: "preflight-product-a", tenantId: tenantA.id, sku: "PREFLIGHT-A", name: "Product A", unit: "unit", listPrice: 1 } }),
    prisma.product.create({ data: { id: "preflight-product-b", tenantId: tenantB.id, sku: "PREFLIGHT-B", name: "Product B", unit: "unit", listPrice: 1 } }),
  ]);

  const orderA = await prisma.order.create({
    data: { id: "preflight-order-a", tenantId: tenantA.id, customerId: customerA.id, reference: "PRE-A" },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      id: "preflight-invoice-b",
      tenantId: tenantB.id,
      number: "PREFLIGHT-INV-B",
      customerId: customerB.id,
      orderId: await prisma.order.create({
        data: { id: "preflight-order-b", tenantId: tenantB.id, customerId: customerB.id, reference: "PRE-B" },
      }).then((order) => order.id),
      dueDate: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  const paymentA = await prisma.payment.create({
    data: { id: "preflight-payment-a", tenantId: tenantA.id, customerId: customerA.id, amount: 1 },
  });

  // These rows model legacy data that a future table-rebuild must reject. The
  // preflight itself must only observe them, never repair or delete them.
  const nullCustomer = await prisma.customer.create({
    data: { id: "preflight-null-customer", name: "Legacy Customer", email: "legacy-customer@example.test" },
  });
  const nullProduct = await prisma.product.create({
    data: { id: "preflight-null-product", sku: "PREFLIGHT-NULL", name: "Legacy Product", unit: "unit", listPrice: 1 },
  });
  const nullCombo = await prisma.comboDiscount.create({
    data: { id: "preflight-null-combo", name: "Legacy Combo", percentOff: 1 },
  });
  const nullOrder = await prisma.order.create({
    data: { id: "preflight-null-order", customerId: customerA.id, reference: "PRE-NULL" },
  });
  const nullInvoice = await prisma.invoice.create({
    data: {
      id: "preflight-null-invoice",
      number: "PREFLIGHT-NULL-INV",
      customerId: customerA.id,
      orderId: orderA.id,
      dueDate: new Date("2027-01-02T00:00:00.000Z"),
    },
  });
  const nullPayment = await prisma.payment.create({
    data: { id: "preflight-null-payment", customerId: customerA.id, amount: 1 },
  });
  const nullIdempotency = await prisma.idempotencyRecord.create({
    data: {
      id: "preflight-null-idempotency",
      clientScope: "preflight",
      method: "POST",
      route: "/preflight",
      idempotencyKey: "preflight-null-idempotency",
      requestFingerprint: "fingerprint",
    },
  });

  // The current tenant-foundation triggers reject these relation mismatches at
  // write time. Keep those guards exercised instead of weakening production
  // integrity merely to manufacture corrupt rows for the read-only preflight.
  for (const operation of [
    () => prisma.rate.create({
      data: { id: "preflight-cross-rate", customerId: customerA.id, productId: productB.id, unitPrice: 1 },
    }),
    () => prisma.order.create({
      data: { id: "preflight-cross-order", tenantId: tenantA.id, customerId: customerB.id, reference: "PRE-CROSS-ORDER" },
    }),
    () => prisma.invoice.create({
      data: {
        id: "preflight-cross-invoice",
        tenantId: tenantB.id,
        number: "PREFLIGHT-CROSS-INV",
        customerId: customerA.id,
        orderId: orderA.id,
        dueDate: new Date("2027-01-03T00:00:00.000Z"),
      },
    }),
    () => prisma.payment.create({
      data: { id: "preflight-cross-payment", tenantId: tenantA.id, customerId: customerB.id, amount: 1 },
    }),
    () => prisma.paymentApplication.create({
      data: { id: "preflight-cross-application", paymentId: paymentA.id, invoiceId: invoiceB.id, amount: 1 },
    }),
  ]) {
    await assert.rejects(
      operation(),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003"
    );
  }

  // Existing global unique indexes are an observable safety guard. The
  // preflight checks the target tenant-scoped shape without weakening them.
  await assert.rejects(
    prisma.product.create({ data: { tenantId: tenantA.id, sku: productA.sku, name: "Duplicate", unit: "unit", listPrice: 1 } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
  await assert.rejects(
    prisma.invoice.create({
      data: {
        tenantId: tenantA.id,
        number: invoiceB.number,
        customerId: customerA.id,
        orderId: nullOrder.id,
        dueDate: new Date("2027-01-04T00:00:00.000Z"),
      },
    }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );

  // SQLite's foreign-key PRAGMA is the non-destructive observable for an
  // orphan. The row remains in place after the preflight runs.
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  await prisma.$executeRawUnsafe(
    "INSERT INTO \"OrderComment\" (\"id\", \"orderId\", \"author\", \"body\", \"createdAt\") VALUES ('preflight-orphan-comment', 'missing-order', 'preflight', 'orphan', CURRENT_TIMESTAMP)"
  );
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");

  const result = await runTenantContractPreflight({ maxIssueSamples: 2 });
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.ready, false);
  for (const code of [
    "MISSING_TENANT_CUSTOMER",
    "MISSING_TENANT_PRODUCT",
    "MISSING_TENANT_COMBO_DISCOUNT",
    "MISSING_TENANT_ORDER",
    "MISSING_TENANT_INVOICE",
    "MISSING_TENANT_PAYMENT",
    "MISSING_TENANT_IDEMPOTENCY_RECORD",
    "ORDER_CUSTOMER_TENANT_MISMATCH",
    "INVOICE_CUSTOMER_TENANT_MISMATCH",
    "INVOICE_ORDER_TENANT_MISMATCH",
    "PAYMENT_CUSTOMER_TENANT_MISMATCH",
    "FOREIGN_KEY_VIOLATION",
  ] as const) assert.ok(codes.has(code), `expected ${code}, received ${[...codes].join(", ")}`);
  assert.equal(codes.has("DUPLICATE_PRODUCT_SKU_PER_TENANT"), false);
  assert.equal(codes.has("DUPLICATE_INVOICE_NUMBER_PER_TENANT"), false);

  // Verify that read-only checks did not rewrite any deliberately bad source row.
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: nullCustomer.id } })).tenantId, null);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: nullProduct.id } })).tenantId, null);
  assert.equal((await prisma.comboDiscount.findUniqueOrThrow({ where: { id: nullCombo.id } })).tenantId, null);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: nullOrder.id } })).tenantId, null);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: nullInvoice.id } })).tenantId, null);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: nullPayment.id } })).tenantId, null);
  assert.equal((await prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: nullIdempotency.id } })).tenantId, null);
  assert.equal(
    await prisma.$queryRaw<readonly { count: bigint }[]>`SELECT COUNT(*) AS count FROM "OrderComment" WHERE "id" = 'preflight-orphan-comment'`.then((rows) => Number(rows[0]?.count)),
    1
  );
}

void main().finally(() => prisma.$disconnect());
