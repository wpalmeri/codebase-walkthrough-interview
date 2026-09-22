import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { PaymentApplicationReversalSchema, PaymentSchema } from "@meridian/contracts";
import { fingerprintIdempotencyKey } from "../audit/auditEvent";
import { createApp } from "../app";
import type { Principal } from "../auth/principal";
import { prisma } from "../db";
import {
  applyPayment,
  recordPayment,
  reversePaymentApplication,
  type PaymentMutationAudit,
} from "./paymentController";

const tenantA = "payment-audit-tenant-a";
const tenantB = "payment-audit-tenant-b";
const customerA = "payment-audit-customer-a";
const customerB = "payment-audit-customer-b";

const principals: Record<string, Principal> = {
  "payment-audit-key-a": {
    tenantId: tenantA,
    subjectId: "service:payment-audit-a",
    credentialId: "credential-payment-audit-a",
    kind: "TENANT_API_KEY",
    role: "BILLING",
  },
  "payment-audit-key-b": {
    tenantId: tenantB,
    subjectId: "service:payment-audit-b",
    credentialId: "credential-payment-audit-b",
    kind: "TENANT_API_KEY",
    role: "BILLING",
  },
};

type ApiResponse = { readonly status: number; readonly body: unknown };

async function request(
  server: Server,
  token: keyof typeof principals,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<ApiResponse> {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("payment audit server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function failingAudit(tenantId: string): PaymentMutationAudit {
  return {
    metadata: {
      tenantId,
      principal: {
        kind: "DEVELOPMENT",
        subjectId: "integration:payment-audit-failure",
        credentialId: "integration-payment-audit-failure",
      },
      requestId: "payment-audit-forced-failure",
    },
    append: async () => {
      throw new Error("forced audit persistence failure");
    },
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function seedInvoice(input: {
  readonly suffix: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly amount: number;
  readonly amountDecimal: string;
  readonly paid?: boolean;
}): Promise<{ paymentId?: string; invoiceId: string; applicationId?: string }> {
  const orderId = `payment-audit-order-${input.suffix}`;
  const invoiceId = `payment-audit-invoice-${input.suffix}`;
  await prisma.order.create({
    data: { id: orderId, tenantId: input.tenantId, customerId: input.customerId, currencyCode: "USD" },
  });
  await prisma.invoice.create({
    data: {
      id: invoiceId,
      tenantId: input.tenantId,
      number: `PAYMENT-AUDIT-${input.suffix}`,
      customerId: input.customerId,
      orderId,
      status: input.paid ? "PAID" : "POSTED",
      dueDate: new Date("2026-10-31T00:00:00.000Z"),
      total: input.amount,
      totalDecimal: input.amountDecimal,
      amountPaid: input.paid ? input.amount : 0,
      amountPaidDecimal: input.paid ? input.amountDecimal : "0.0000",
      currencyCode: "USD",
      accountingDate: "2026-09-22",
      postedAt: new Date("2026-09-22T00:00:00.000Z"),
    },
  });
  if (!input.paid) return { invoiceId };

  const paymentId = `payment-audit-payment-${input.suffix}`;
  const applicationId = `payment-audit-application-${input.suffix}`;
  await prisma.payment.create({
    data: {
      id: paymentId,
      tenantId: input.tenantId,
      customerId: input.customerId,
      amount: input.amount,
      amountDecimal: input.amountDecimal,
      currencyCode: "USD",
    },
  });
  await prisma.paymentApplication.create({
    data: {
      id: applicationId,
      paymentId,
      invoiceId,
      amount: input.amount,
      amountDecimal: input.amountDecimal,
    },
  });
  return { paymentId, invoiceId, applicationId };
}

async function main(): Promise<void> {
  await prisma.tenant.createMany({
    data: [
      { id: tenantA, slug: tenantA, name: "Payment Audit Tenant A" },
      { id: tenantB, slug: tenantB, name: "Payment Audit Tenant B" },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { id: customerA, tenantId: tenantA, name: "Payment Audit Customer A", email: "audit-a@example.com" },
      { id: customerB, tenantId: tenantB, name: "Payment Audit Customer B", email: "audit-b@example.com" },
    ],
  });
  const payable = await seedInvoice({
    suffix: "payable", tenantId: tenantA, customerId: customerA, amount: 10, amountDecimal: "10.0000",
  });
  const foreignInvoice = await seedInvoice({
    suffix: "foreign", tenantId: tenantB, customerId: customerB, amount: 10, amountDecimal: "10.0000",
  });
  const app = createApp({
    principalResolver: { resolve: async (token) => principals[token] ?? null },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const receiptKey = "payment-audit-receipt-key";
    const receiptHeaders = {
      "x-request-id": "payment-audit-request-receipt",
      "idempotency-key": receiptKey,
      "idempotency-client": "payment-audit-integration",
    };
    const firstReceipt = await request(
      server,
      "payment-audit-key-a",
      "/payments",
      { customerId: customerA, amount: "10.0000", reference: "audit receipt" },
      receiptHeaders
    );
    assert.equal(firstReceipt.status, 200);
    const payment = PaymentSchema.parse(firstReceipt.body);
    const replay = await request(
      server,
      "payment-audit-key-a",
      "/payments",
      { customerId: customerA, amount: "10.0000", reference: "audit receipt" },
      { ...receiptHeaders, "x-request-id": "payment-audit-request-receipt-replay" }
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, firstReceipt.body);

    const applyKey = "payment-audit-apply-key";
    const applyHeaders = {
      "x-request-id": "payment-audit-request-apply",
      "idempotency-key": applyKey,
      "idempotency-client": "payment-audit-integration",
    };
    const applied = await request(
      server,
      "payment-audit-key-a",
      `/payments/${payment.id}/apply`,
      { applications: [{ invoiceId: payable.invoiceId, amount: "10.0000" }] },
      applyHeaders
    );
    assert.equal(applied.status, 200);
    const appliedReplay = await request(
      server,
      "payment-audit-key-a",
      `/payments/${payment.id}/apply`,
      { applications: [{ invoiceId: payable.invoiceId, amount: "10.0000" }] },
      { ...applyHeaders, "x-request-id": "payment-audit-request-apply-replay" }
    );
    assert.equal(appliedReplay.status, 200);
    assert.deepEqual(appliedReplay.body, applied.body);
    const application = await prisma.paymentApplication.findFirstOrThrow({
      where: { paymentId: payment.id, invoiceId: payable.invoiceId },
    });

    const reversalKey = "payment-audit-reversal-key";
    const reversed = await request(
      server,
      "payment-audit-key-a",
      `/payments/${payment.id}/applications/${application.id}/reversals`,
      { amount: "1.0000", reason: "Audit correction", accountingDate: "2026-09-23" },
      {
        "x-request-id": "payment-audit-request-reversal",
        "idempotency-key": reversalKey,
        "idempotency-client": "payment-audit-integration",
      }
    );
    assert.equal(reversed.status, 201);
    const reversal = PaymentApplicationReversalSchema.parse(reversed.body);

    const auditBeforeFailures = await prisma.auditEvent.count();
    const foreignReceipt = await request(
      server,
      "payment-audit-key-a",
      "/payments",
      { customerId: customerB, amount: "1.0000" },
      { "x-request-id": "payment-audit-request-foreign-receipt" }
    );
    assert.equal(foreignReceipt.status, 404);
    const invalidApply = await request(
      server,
      "payment-audit-key-a",
      `/payments/${payment.id}/apply`,
      { applications: [{ invoiceId: foreignInvoice.invoiceId, amount: "1.0000" }] },
      { "x-request-id": "payment-audit-request-foreign-apply" }
    );
    assert.equal(invalidApply.status, 404);
    assert.equal(await prisma.auditEvent.count(), auditBeforeFailures);

    const events = await prisma.auditEvent.findMany({ orderBy: { occurredAt: "asc" } });
    assert.equal(events.length, 3, "idempotent replays and failed requests append no duplicate evidence");
    const receiptEvent = events.find(({ action }) => action === "PAYMENT_RECORDED");
    const applicationEvent = events.find(({ action }) => action === "PAYMENT_APPLIED");
    const reversalEvent = events.find(({ action }) => action === "PAYMENT_APPLICATION_REVERSED");
    assert.deepEqual(receiptEvent, {
      id: receiptEvent?.id,
      tenantId: tenantA,
      action: "PAYMENT_RECORDED",
      principalKind: "TENANT_API_KEY",
      principalSubject: principals["payment-audit-key-a"].subjectId,
      principalCredentialId: principals["payment-audit-key-a"].credentialId,
      requestId: "payment-audit-request-receipt",
      idempotencyKeyFingerprint: fingerprintIdempotencyKey(receiptKey),
      resourceKind: "PAYMENT",
      resourceId: payment.id,
      occurredAt: receiptEvent?.occurredAt,
    });
    assert.equal(applicationEvent?.resourceId, application.id);
    assert.equal(applicationEvent?.tenantId, tenantA);
    assert.equal(applicationEvent?.principalSubject, principals["payment-audit-key-a"].subjectId);
    assert.equal(applicationEvent?.principalCredentialId, principals["payment-audit-key-a"].credentialId);
    assert.equal(applicationEvent?.requestId, "payment-audit-request-apply");
    assert.equal(applicationEvent?.action, "PAYMENT_APPLIED");
    assert.equal(applicationEvent?.idempotencyKeyFingerprint, fingerprintIdempotencyKey(applyKey));
    assert.equal(reversalEvent?.resourceId, reversal.id);
    assert.equal(reversalEvent?.tenantId, tenantA);
    assert.equal(reversalEvent?.principalKind, "TENANT_API_KEY");
    assert.equal(reversalEvent?.requestId, "payment-audit-request-reversal");
    assert.equal(reversalEvent?.action, "PAYMENT_APPLICATION_REVERSED");
    assert.equal(reversalEvent?.idempotencyKeyFingerprint, fingerprintIdempotencyKey(reversalKey));
    assert.equal(JSON.stringify(events).includes(receiptKey), false);

    const failureInvoice = await seedInvoice({
      suffix: "failure-apply", tenantId: tenantA, customerId: customerA, amount: 5, amountDecimal: "5.0000",
    });
    const paymentCount = await prisma.payment.count();
    await assert.rejects(
      recordPayment(tenantA, { customerId: customerA, amount: "1.0000" }, failingAudit(tenantA)),
      /forced audit persistence failure/u
    );
    assert.equal(await prisma.payment.count(), paymentCount, "receipt rolls back when audit append fails");

    const failurePaymentId = "payment-audit-failure-apply";
    await prisma.payment.create({
      data: {
        id: failurePaymentId,
        tenantId: tenantA,
        customerId: customerA,
        amount: 5,
        amountDecimal: "5.0000",
        currencyCode: "USD",
      },
    });
    const applicationsBeforeFailure = await prisma.paymentApplication.count();
    await assert.rejects(
      applyPayment(
        tenantA,
        failurePaymentId,
        [{ invoiceId: failureInvoice.invoiceId, amount: "5.0000" }],
        failingAudit(tenantA)
      ),
      /forced audit persistence failure/u
    );
    assert.equal(await prisma.paymentApplication.count(), applicationsBeforeFailure);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: failureInvoice.invoiceId } })).amountPaid, 0);

    const reversalFailure = await seedInvoice({
      suffix: "failure-reversal", tenantId: tenantA, customerId: customerA, amount: 5, amountDecimal: "5.0000", paid: true,
    });
    const reversalsBeforeFailure = await prisma.paymentApplicationReversal.count();
    await assert.rejects(
      reversePaymentApplication(
        tenantA,
        reversalFailure.paymentId ?? "",
        reversalFailure.applicationId ?? "",
        { amount: "1.0000", reason: "Forced audit failure", accountingDate: "2026-09-23" },
        failingAudit(tenantA)
      ),
      /forced audit persistence failure/u
    );
    assert.equal(await prisma.paymentApplicationReversal.count(), reversalsBeforeFailure);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: reversalFailure.invoiceId } })).amountPaid, 5);
    assert.equal(await prisma.auditEvent.count(), auditBeforeFailures, "failed audit writes leave no evidence behind");
  } finally {
    await close(server);
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
