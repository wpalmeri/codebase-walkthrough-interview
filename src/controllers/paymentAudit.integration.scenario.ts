import assert from "node:assert/strict";
import { prisma } from "../db";
import { recordPayment, type PaymentMutationAudit } from "./paymentController";

const audit = (requestId: string): PaymentMutationAudit => ({
  metadata: {
    principal: { kind: "DEVELOPMENT", subjectId: "payment-audit", credentialId: "payment-audit" },
    requestId,
  },
});

async function main(): Promise<void> {
  try {
    const customer = await prisma.customer.create({ data: { name: "Payment audit customer", email: "payment-audit@example.com" } });
    const payment = await recordPayment({ customerId: customer.id, amount: "12.3400" }, audit("payment-audit-recorded"));
    assert.equal(payment.customerId, customer.id);
    assert.equal(payment.amountDecimal, "12.3400");
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { requestId: "payment-audit-recorded" } });
    assert.equal(event.action, "PAYMENT_RECORDED");
    assert.equal(event.resourceId, payment.id);

    const before = await prisma.payment.count();
    await assert.rejects(
      recordPayment({ customerId: customer.id, amount: "1.0000" }, {
        ...audit("payment-audit-rollback"),
        append: async () => { throw new Error("audit persistence failed"); },
      }),
      /audit persistence failed/u
    );
    assert.equal(await prisma.payment.count(), before);
    assert.equal(await prisma.auditEvent.count({ where: { requestId: "payment-audit-rollback" } }), 0);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
