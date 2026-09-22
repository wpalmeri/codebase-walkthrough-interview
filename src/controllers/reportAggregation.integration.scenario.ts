import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { reversePaymentApplication, type PaymentMutationAudit } from "./paymentController";
import {
  annualRevenue,
  createRevenueAggregateRepository,
  revenueByCustomer,
  revenueByQuarter,
} from "./reportController";

function audit(): PaymentMutationAudit {
  return {
    metadata: {
      principal: {
        kind: "DEVELOPMENT",
        subjectId: "integration:report-aggregation",
        credentialId: "integration-report-aggregation",
      },
      requestId: "report-aggregation-reversal",
    },
  };
}

async function createInvoice(input: {
  id: string;
  customerId: string;
  customerName: string;
  accountingDate: string | null;
  issueDate: Date;
  status: "DRAFT" | "POSTED" | "SENT" | "PAID";
  total: string;
  amountPaid?: string;
  captureCustomerName?: boolean;
}): Promise<void> {
  await prisma.customer.upsert({
    where: { id: input.customerId },
    create: {
      id: input.customerId,
      name: input.customerName,
      email: `${input.customerId}@example.com`,
    },
    update: {},
  });
  const orderId = `${input.id}-order`;
  await prisma.order.create({
    data: { id: orderId, customerId: input.customerId, currencyCode: "USD", status: "INVOICED" },
  });
  const total = Number(input.total);
  const amountPaid = input.amountPaid === undefined ? 0 : Number(input.amountPaid);
  try {
    await prisma.invoice.create({
      data: {
      id: input.id,
      number: `REPORT-${input.id}`,
      customerId: input.customerId,
      orderId,
      status: input.status,
      issueDate: input.issueDate,
      dueDate: new Date("2026-12-31T00:00:00.000Z"),
      total,
      totalDecimal: input.total,
      amountPaid,
      amountPaidDecimal: input.amountPaid,
      customerNameSnapshot: input.captureCustomerName === false ? null : input.customerName,
      currencyCode: "USD",
      accountingDate: input.accountingDate,
      postedAt: input.status === "DRAFT" ? null : input.issueDate,
      },
    });
  } catch (error) {
    throw new Error(`failed to seed report invoice ${input.id}`, { cause: error });
  }
}

async function main(): Promise<void> {
  try {
    const reportQueries: Prisma.Sql[] = [];
    const pagedRepository = createRevenueAggregateRepository(
      {
        async $queryRaw(query) {
          reportQueries.push(query);
          return prisma.$queryRaw<unknown[]>(query);
        },
      },
      2
    );
    // Two invoices deliberately share both customer and accounting date. Their
    // 0.1000 + 0.2000 total proves each bounded SQL page crosses as decimal
    // strings and application reduction uses the exact decimal boundary.
    await createInvoice({
      id: "report-a-q1-one",
      customerId: "report-customer-a",
      customerName: "Same customer name",
      accountingDate: "2026-03-31",
      issueDate: new Date("2026-03-31T00:00:00.000Z"),
      status: "POSTED",
      total: "0.1000",
    });
    await createInvoice({
      id: "report-a-q1-two",
      customerId: "report-customer-a",
      customerName: "Same customer name",
      accountingDate: "2026-03-31",
      issueDate: new Date("2026-03-31T01:00:00.000Z"),
      status: "SENT",
      total: "0.2000",
    });
    await createInvoice({
      id: "report-a-reversed-payment",
      customerId: "report-customer-b",
      customerName: "Same customer name",
      accountingDate: "2026-04-01",
      issueDate: new Date("2026-04-01T00:00:00.000Z"),
      status: "PAID",
      total: "5.0000",
      amountPaid: "5.0000",
    });
    await createInvoice({
      id: "report-a-q2-captured",
      customerId: "report-customer-a",
      customerName: "Same customer name",
      accountingDate: "2026-06-30",
      issueDate: new Date("2026-06-30T23:59:59.000Z"),
      status: "SENT",
      total: "1.0000",
    });
    await createInvoice({
      id: "report-a-draft",
      customerId: "report-customer-a",
      customerName: "Same customer name",
      accountingDate: "2026-04-01",
      issueDate: new Date("2026-04-01T00:00:00.000Z"),
      status: "DRAFT",
      total: "100.0000",
    });
    await createInvoice({
      id: "report-a-prior-year",
      customerId: "report-customer-a",
      customerName: "Same customer name",
      accountingDate: "2025-12-31",
      issueDate: new Date("2025-12-31T00:00:00.000Z"),
      status: "POSTED",
      total: "7.0000",
    });
    await createInvoice({
      id: "report-b-foreign",
      customerId: "report-customer-foreign",
      customerName: "Second customer",
      accountingDate: "2026-04-01",
      issueDate: new Date("2026-04-01T00:00:00.000Z"),
      status: "POSTED",
      total: "900.0000",
    });
    await createInvoice({
      id: "report-a-legacy-name-fallback",
      customerId: "report-customer-legacy-name",
      customerName: "Legacy name before rename",
      accountingDate: "2024-01-01",
      issueDate: new Date("2024-01-01T00:00:00.000Z"),
      status: "POSTED",
      total: "2.0000",
      captureCustomerName: false,
    });

    await prisma.customer.update({
      where: { id: "report-customer-a" },
      data: { name: "Renamed live customer A" },
    });
    await prisma.customer.update({
      where: { id: "report-customer-legacy-name" },
      data: { name: "Renamed legacy live fallback" },
    });

    const capturedIdentityPage = await pagedRepository.page(
      { from: "2026-01-01", to: "2026-12-31" },
      null
    );
    assert.equal(
      capturedIdentityPage.find(({ id }) => id === "report-a-q1-one")?.customerName,
      "Same customer name",
      "renaming a customer must not rewrite recognized invoice identity"
    );
    const legacyIdentityPage = await pagedRepository.page(
      { from: "2024-01-01", to: "2024-12-31" },
      null
    );
    assert.equal(
      legacyIdentityPage.find(({ id }) => id === "report-a-legacy-name-fallback")?.customerName,
      "Renamed legacy live fallback",
      "a null legacy snapshot uses the explicit live-data fallback until backfill"
    );
    reportQueries.length = 0;

    await prisma.payment.create({
      data: {
        id: "report-a-payment",
        customerId: "report-customer-b",
        amount: 5,
        amountDecimal: "5.0000",
        currencyCode: "USD",
      },
    });
    await prisma.paymentApplication.create({
      data: {
        id: "report-a-payment-application",
        paymentId: "report-a-payment",
        invoiceId: "report-a-reversed-payment",
        amount: 5,
        amountDecimal: "5.0000",
      },
    });
    await reversePaymentApplication(
      "report-a-payment",
      "report-a-payment-application",
      { amount: "1.0000", reason: "Partial payment reversal", accountingDate: "2026-05-01" },
      audit()
    );
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: "report-a-reversed-payment" } })).status, "POSTED");

    assert.deepEqual(await revenueByQuarter({ from: "2026-01-01", to: "2026-09-30" }, pagedRepository), [
      { quarter: "2026-Q1", invoiceCount: 2, revenue: 0.3, revenueDecimal: "0.3000" },
      { quarter: "2026-Q2", invoiceCount: 3, revenue: 906, revenueDecimal: "906.0000" },
      { quarter: "2026-Q3", invoiceCount: 0, revenue: 0, revenueDecimal: "0.0000" },
    ]);
    assert.equal(reportQueries.length, 4, "five invoices at a two-row cap require three pages plus an empty terminator");
    assert.equal(reportQueries.every((query) => query.strings.join("?").includes("LIMIT ?")), true);
    assert.equal(reportQueries.every((query) => !query.strings.join("?").includes("json_group_array")), true);
    assert.equal(reportQueries.every((query) => query.values.at(-1) === 2), true);
    assert.deepEqual(await revenueByCustomer({ from: "2026-01-01", to: "2026-06-30" }, pagedRepository), [
      {
        customerId: "report-customer-foreign",
        customerName: "Second customer",
        invoiceCount: 1,
        revenue: 900,
        revenueDecimal: "900.0000",
      },
      {
        customerId: "report-customer-b",
        customerName: "Same customer name",
        invoiceCount: 1,
        revenue: 5,
        revenueDecimal: "5.0000",
      },
      {
        customerId: "report-customer-a",
        customerName: "Same customer name",
        invoiceCount: 3,
        revenue: 1.3,
        revenueDecimal: "1.3000",
      },
    ]);
    assert.deepEqual(await annualRevenue({ from: "2025-01-01", to: "2027-12-31" }, pagedRepository), [
      { year: 2025, invoiceCount: 1, revenue: 7, revenueDecimal: "7.0000" },
      { year: 2026, invoiceCount: 5, revenue: 906.3, revenueDecimal: "906.3000" },
      { year: 2027, invoiceCount: 0, revenue: 0, revenueDecimal: "0.0000" },
    ]);
    assert.deepEqual(await revenueByCustomer({ from: "2026-06-30", to: "2026-06-30" }, pagedRepository), [
      {
        customerId: "report-customer-a",
        customerName: "Same customer name",
        invoiceCount: 1,
        revenue: 1,
        revenueDecimal: "1.0000",
      },
    ]);
    assert.deepEqual(await revenueByQuarter({ from: "2027-01-01", to: "2027-03-31" }, pagedRepository), [
      { quarter: "2027-Q1", invoiceCount: 0, revenue: 0, revenueDecimal: "0.0000" },
    ]);
    assert.deepEqual(await revenueByCustomer({ from: "2027-01-01", to: "2027-12-31" }, pagedRepository), []);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
