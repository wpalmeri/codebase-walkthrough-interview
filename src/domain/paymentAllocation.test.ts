import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MONEY_PRECISION, MONEY_SCALE, addDecimal, compareDecimal } from "./money";
import { planPaymentAllocation } from "./paymentAllocation";

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;

const payment = {
  id: "payment-1",
  customerId: "customer-1",
  currencyCode: "USD",
  remainingAmount: "100.0000",
} as const;

const invoice = {
  id: "invoice-1",
  customerId: "customer-1",
  currencyCode: "USD",
  status: "POSTED",
  remainingAmount: "80.0000",
} as const;

function request(overrides: Record<string, unknown> = {}) {
  return {
    payment,
    invoices: [invoice],
    applications: [{ invoiceId: invoice.id, amount: "25.0000" }],
    ...overrides,
  };
}

void describe("payment allocation planning", () => {
  void test("returns exact partial and full-allocation balances without float arithmetic", () => {
    assert.deepEqual(planPaymentAllocation(request()), {
      paymentId: "payment-1",
      paymentRemainingBefore: "100.0000",
      appliedAmount: "25.0000",
      paymentRemainingAfter: "75.0000",
      applications: [
        {
          invoiceId: "invoice-1",
          amount: "25.0000",
          invoiceRemainingBefore: "80.0000",
          invoiceRemainingAfter: "55.0000",
        },
      ],
    });
    const exact = planPaymentAllocation(
      request({
        payment: { ...payment, remainingAmount: "80.0000" },
        applications: [{ invoiceId: invoice.id, amount: "80.0000" }],
      })
    );
    assert.equal(exact.paymentRemainingAfter, "0.0000");
    assert.equal(exact.applications[0]?.invoiceRemainingAfter, "0.0000");
  });

  void test("rejects non-positive applications and noncanonical monetary input", () => {
    assert.throws(
      () => planPaymentAllocation(request({ applications: [{ invoiceId: invoice.id, amount: "0.0000" }] })),
      /greater than zero/
    );
    assert.throws(
      () => planPaymentAllocation(request({ applications: [{ invoiceId: invoice.id, amount: "-1.0000" }] })),
      /Invalid string/
    );
    assert.throws(
      () => planPaymentAllocation(request({ applications: [{ invoiceId: invoice.id, amount: "1.2" }] })),
      /Invalid string/
    );
  });

  void test("rejects wrong customer, unsupported currency, and invoice lifecycle states", () => {
    assert.throws(
      () => planPaymentAllocation(request({ invoices: [{ ...invoice, customerId: "customer-2" }] })),
      /different customer/
    );
    assert.throws(
      () => planPaymentAllocation(request({ invoices: [{ ...invoice, currencyCode: "EUR" }] })),
      /Invalid input/
    );
    for (const status of ["DRAFT", "VOID", "PAID"] as const) {
      assert.throws(
        () => planPaymentAllocation(request({ invoices: [{ ...invoice, status }] })),
        /must be POSTED or SENT/
      );
    }
  });

  void test("rejects duplicate targets and payment or invoice overapplication", () => {
    assert.throws(
      () =>
        planPaymentAllocation(
          request({
            applications: [
              { invoiceId: invoice.id, amount: "1.0000" },
              { invoiceId: invoice.id, amount: "1.0000" },
            ],
          })
        ),
      /application invoice IDs must be unique/
    );
    assert.throws(
      () => planPaymentAllocation(request({ applications: [{ invoiceId: invoice.id, amount: "80.0001" }] })),
      /exceeds its remaining balance/
    );
    assert.throws(
      () =>
        planPaymentAllocation(
          request({
            payment: { ...payment, remainingAmount: "20.0000" },
            applications: [{ invoiceId: invoice.id, amount: "25.0000" }],
          })
        ),
      /exceed the payment remaining balance/
    );
  });

  void test("sorts plan applications so equivalent inputs produce deterministic results", () => {
    const otherInvoice = { ...invoice, id: "invoice-2", remainingAmount: "20.0000" };
    const plan = planPaymentAllocation(
      request({
        invoices: [invoice, otherInvoice],
        applications: [
          { invoiceId: "invoice-2", amount: "10.0000" },
          { invoiceId: "invoice-1", amount: "10.0000" },
        ],
      })
    );
    assert.deepEqual(plan.applications.map((application) => application.invoiceId), [
      "invoice-1",
      "invoice-2",
    ]);
    assert.equal(plan.appliedAmount, "20.0000");
  });

  void test("shows why independent valid plans still need compare-and-set or serializable writes", () => {
    const sharedSnapshot = request({
      payment: { ...payment, remainingAmount: "100.0000" },
      invoices: [{ ...invoice, remainingAmount: "100.0000" }],
      applications: [{ invoiceId: invoice.id, amount: "75.0000" }],
    });
    const firstPlan = planPaymentAllocation(sharedSnapshot);
    const secondPlan = planPaymentAllocation(sharedSnapshot);

    assert.equal(firstPlan.paymentRemainingAfter, "25.0000");
    assert.equal(secondPlan.paymentRemainingAfter, "25.0000");
    assert.equal(firstPlan.appliedAmount, "75.0000");
    assert.equal(secondPlan.appliedAmount, "75.0000");
    const combinedApplicationAmount = addDecimal(
      firstPlan.appliedAmount,
      secondPlan.appliedAmount,
      moneyFormat
    );
    // Both plans are valid against the same stale snapshot, but writing both is an overapplication.
    assert.equal(combinedApplicationAmount, "150.0000");
    assert.ok(
      compareDecimal(combinedApplicationAmount, sharedSnapshot.payment.remainingAmount, moneyFormat) > 0
    );
  });
});
