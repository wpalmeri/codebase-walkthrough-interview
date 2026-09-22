import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planPaymentApplicationReversal } from "./paymentReversal";

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestedPaymentId: "payment-1",
    amount: "25.0000",
    application: {
      id: "application-1",
      paymentId: "payment-1",
      amount: "100.0000",
      reversedAmount: "0.0000",
      paymentCustomerId: "customer-1",
      paymentCurrencyCode: "USD",
      invoiceCustomerId: "customer-1",
      invoiceCurrencyCode: "USD",
    },
    invoice: {
      status: "PAID",
      total: "100.0000",
      grossAppliedAmount: "100.0000",
      reversedAmount: "0.0000",
      hasSuccessfulDelivery: false,
    },
    ...overrides,
  };
}

void describe("payment application reversal planning", () => {
  void test("plans partial and full reversals with exact net balances", () => {
    assert.deepEqual(planPaymentApplicationReversal(request()), {
      applicationRemainingBefore: "100.0000",
      applicationRemainingAfter: "75.0000",
      invoiceAmountPaidBefore: "100.0000",
      invoiceAmountPaidAfter: "75.0000",
      invoiceStatusAfter: "POSTED",
    });
    assert.deepEqual(
      planPaymentApplicationReversal(request({ amount: "100.0000" })),
      {
        applicationRemainingBefore: "100.0000",
        applicationRemainingAfter: "0.0000",
        invoiceAmountPaidBefore: "100.0000",
        invoiceAmountPaidAfter: "0.0000",
        invoiceStatusAfter: "POSTED",
      }
    );
  });

  void test("restores SENT only from persisted successful delivery evidence", () => {
    const plan = planPaymentApplicationReversal(
      request({
        invoice: {
          status: "PAID",
          total: "100.0000",
          grossAppliedAmount: "100.0000",
          reversedAmount: "0.0000",
          hasSuccessfulDelivery: true,
        },
      })
    );
    assert.equal(plan.invoiceStatusAfter, "SENT");
  });

  void test("rejects over-reversal and commercial identity mismatches", () => {
    assert.throws(
      () =>
        planPaymentApplicationReversal(
          request({
            amount: "50.0000",
            application: {
              ...request().application,
              reversedAmount: "75.0000",
            },
          })
        ),
      /exceeds the application remaining/u
    );
    assert.throws(
      () =>
        planPaymentApplicationReversal(
          request({
            application: {
              ...request().application,
              invoiceCustomerId: "customer-2",
            },
          })
        ),
      /customers do not match/u
    );
  });

  void test("rejects zero amounts and already-overreversed snapshots", () => {
    assert.throws(
      () => planPaymentApplicationReversal(request({ amount: "0.0000" })),
      /greater than zero/u
    );
    assert.throws(
      () =>
        planPaymentApplicationReversal(
          request({
            application: {
              ...request().application,
              reversedAmount: "100.0001",
            },
          })
        ),
      /already over-reversed/u
    );
    assert.throws(
      () =>
        planPaymentApplicationReversal(
          request({
            invoice: {
              ...request().invoice,
              reversedAmount: "100.0001",
            },
          })
        ),
      /already over-reversed/u
    );
  });
});
