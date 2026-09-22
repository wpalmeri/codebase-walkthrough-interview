import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_PAYMENT_CURRENCY,
  PAYMENT_REVERSAL_ACTOR,
  PaymentAllocationConflictError,
  applyPaymentWithDependencies,
  createPaymentWithDependencies,
  reversePaymentApplicationWithDependencies,
  type InvoiceLedgerSnapshot,
  type PaymentAllocationDependencies,
  type PaymentLedgerSnapshot,
  type PaymentReversalDependencies,
  type PaymentReversalSnapshot,
  type PaymentReversalTransaction,
} from "./paymentController";
import type { InvoiceStatus } from "@meridian/contracts";
import {
  DomainInvariantError,
  NotFoundError,
  PreconditionError,
} from "../errors";

const payment: PaymentLedgerSnapshot = {
  id: "payment-1",
  customerId: "customer-1",
  currencyCode: "USD",
  amount: 100,
  amountDecimal: "100.0000",
  applications: [],
};
const invoice: InvoiceLedgerSnapshot = {
  id: "invoice-1",
  customerId: "customer-1",
  currencyCode: "USD",
  status: "POSTED",
  total: 80,
  totalDecimal: "80.0000",
  amountPaid: 0,
  amountPaidDecimal: "0.0000",
  applications: [],
};

function reversalSnapshot(input: {
  reversedAmounts?: readonly string[];
  amountPaidDecimal?: string;
  amountPaid?: number;
  status?: InvoiceStatus;
  closedThroughDate?: string | null;
  successfulDelivery?: boolean;
} = {}): PaymentReversalSnapshot {
  const reversedAmounts = input.reversedAmounts ?? [];
  const reversals = reversedAmounts.map((amountDecimal) => ({ amountDecimal }));
  const amountPaidDecimal = input.amountPaidDecimal ?? "100.0000";
  return {
    id: "application-1",
    paymentId: "payment-1",
    amountDecimal: "100.0000",
    payment: { customerId: "customer-1", currencyCode: "USD" },
    reversals,
    invoice: {
      id: "invoice-1",
      customerId: "customer-1",
      currencyCode: "USD",
      status: input.status ?? "PAID",
      total: 100,
      totalDecimal: "100.0000",
      amountPaid: input.amountPaid ?? Number(amountPaidDecimal),
      amountPaidDecimal,
      applications: [
        {
          amount: 100,
          amountDecimal: "100.0000",
          reversals,
        },
      ],
      transmissions: input.successfulDelivery
        ? [{ method: "EMAIL", status: "SENT" }]
        : [],
    },
    closedThroughDate: input.closedThroughDate ?? null,
  };
}

function reversalStore(
  initial: PaymentReversalSnapshot = reversalSnapshot()
): PaymentReversalDependencies & {
  readonly writes: Parameters<PaymentReversalTransaction["persistReversal"]>[0][];
} {
  const writes: Parameters<PaymentReversalTransaction["persistReversal"]>[0][] = [];
  return {
    writes,
    async transaction(operation) {
      return operation({
        async loadApplication() {
          return initial;
        },
        async persistReversal(write) {
          writes.push(write);
          return true;
        },
      });
    },
  };
}

function transactionalStore(
  state: { payment?: PaymentLedgerSnapshot; invoices?: readonly InvoiceLedgerSnapshot[] } = {}
): PaymentAllocationDependencies & {
  readonly writes: { applications: readonly unknown[]; invoiceBalances: readonly unknown[] }[];
} {
  const writes: { applications: readonly unknown[]; invoiceBalances: readonly unknown[] }[] = [];
  return {
    writes,
    async transaction(operation) {
      const transaction = {
        async loadPayment() {
          return state.payment ?? payment;
        },
        async loadInvoices() {
          return state.invoices ?? [invoice];
        },
        async persistAllocation(write: {
          readonly applications: readonly unknown[];
          readonly invoiceBalances: readonly unknown[];
        }) {
          writes.push(write);
          return true;
        },
      };
      return operation(transaction);
    },
  };
}

void describe("payment controller atomic workflow", () => {
  void test("dual-writes Decimal and legacy amounts and defaults legacy clients to documented USD", async () => {
    let created: unknown;
    const result = await createPaymentWithDependencies(
      { customerId: "customer-1", amount: "12.3400", reference: "wire-1" },
      {
        async createPayment(input) {
          created = input;
          return { id: "payment-1" };
        },
      }
    );
    assert.equal(result.id, "payment-1");
    assert.deepEqual(created, {
      customerId: "customer-1",
      amount: 12.34,
      amountDecimal: "12.3400",
      currencyCode: DEFAULT_PAYMENT_CURRENCY,
      reference: "wire-1",
    });
  });

  void test("commits exact partial and full allocations as one immutable write set", async () => {
    const partialStore = transactionalStore();
    const partial = await applyPaymentWithDependencies(
      "payment-1",
      [{ invoiceId: "invoice-1", amount: "25.0000" }],
      partialStore
    );
    assert.equal(partial.appliedAmount, "25.0000");
    assert.equal(partial.paymentRemainingAfter, "75.0000");
    assert.equal(partial.applications[0]?.invoiceRemainingAfter, "55.0000");
    assert.equal(partialStore.writes.length, 1);

    const fullStore = transactionalStore({
      payment: { ...payment, amount: 80, amountDecimal: "80.0000" },
    });
    const full = await applyPaymentWithDependencies(
      "payment-1",
      [{ invoiceId: "invoice-1", amount: "80.0000" }],
      fullStore
    );
    assert.equal(full.paymentRemainingAfter, "0.0000");
    assert.equal(full.applications[0]?.invoiceRemainingAfter, "0.0000");
  });

  void test("does not write when ownership or lifecycle validation fails", async () => {
    const store = transactionalStore({ invoices: [{ ...invoice, customerId: "customer-2" }] });
    await assert.rejects(
      applyPaymentWithDependencies(
        "payment-1",
        [{ invoiceId: "invoice-1", amount: "10.0000" }],
        store
      ),
      (error) => {
        assert.ok(error instanceof DomainInvariantError);
        assert.equal(error.problem.status, 422);
        assert.equal(error.problem.code, "PAYMENT_ALLOCATION_INVALID");
        return true;
      }
    );
    assert.equal(store.writes.length, 0);

    const draftStore = transactionalStore({ invoices: [{ ...invoice, status: "DRAFT" }] });
    await assert.rejects(
      applyPaymentWithDependencies(
        "payment-1",
        [{ invoiceId: "invoice-1", amount: "10.0000" }],
        draftStore
      ),
      (error) => {
        assert.ok(error instanceof DomainInvariantError);
        assert.equal(error.problem.status, 422);
        assert.equal(error.problem.code, "PAYMENT_ALLOCATION_INVALID");
        return true;
      }
    );
    assert.equal(draftStore.writes.length, 0);
  });

  void test("returns a not-found problem and performs no write when an invoice is missing", async () => {
    const store = transactionalStore({ invoices: [] });

    await assert.rejects(
      applyPaymentWithDependencies(
        "payment-1",
        [{ invoiceId: "missing-invoice", amount: "10.0000" }],
        store
      ),
      (error) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.problem.status, 404);
        assert.equal(error.problem.code, "PAYMENT_INVOICE_NOT_FOUND");
        assert.doesNotMatch(JSON.stringify(error.problem), /missing-invoice/);
        return true;
      }
    );
    assert.equal(store.writes.length, 0);
  });

  void test("treats a failed atomic persistence attempt as a rollback, without partial application writes", async () => {
    const store: PaymentAllocationDependencies & { attempts: number } = {
      attempts: 0,
      async transaction(operation) {
        return operation({
          async loadPayment() {
            return payment;
          },
          async loadInvoices() {
            return [invoice];
          },
          async persistAllocation() {
            store.attempts += 1;
            return false;
          },
        });
      },
    };
    await assert.rejects(
      applyPaymentWithDependencies(
        "payment-1",
        [{ invoiceId: "invoice-1", amount: "10.0000" }],
        store
      ),
      PaymentAllocationConflictError
    );
    assert.equal(store.attempts, 3);
  });

  void test("allows only one of two stale interleaved attempts to commit", async () => {
    let committed = false;
    let readers = 0;
    let releaseSnapshotReads: (() => void) | undefined;
    const bothReadSnapshot = new Promise<void>((resolve) => {
      releaseSnapshotReads = resolve;
    });
    const staleAttemptStore: PaymentAllocationDependencies = {
      async transaction(operation) {
        return operation({
          async loadPayment() {
            readers += 1;
            if (readers === 2) releaseSnapshotReads?.();
            await bothReadSnapshot;
            return payment;
          },
          async loadInvoices() {
            return [{ ...invoice, total: 100, totalDecimal: "100.0000" }];
          },
          async persistAllocation() {
            if (committed) return false;
            committed = true;
            return true;
          },
        });
      },
    };
    const results = await Promise.allSettled([
      applyPaymentWithDependencies(
        "payment-1",
        [{ invoiceId: "invoice-1", amount: "75.0000" }],
        staleAttemptStore
      ),
      applyPaymentWithDependencies(
        "payment-1",
        [{ invoiceId: "invoice-1", amount: "75.0000" }],
        staleAttemptStore
      ),
    ]);
    const successfulPlans = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof applyPaymentWithDependencies>>> =>
        result.status === "fulfilled"
    );
    const rejectedPlans = results.filter((result) => result.status === "rejected");
    assert.equal(successfulPlans.length, 1);
    assert.equal(rejectedPlans.length, 1);
    assert.equal(successfulPlans[0]?.value.appliedAmount, "75.0000");
    assert.ok(rejectedPlans[0]?.reason instanceof PaymentAllocationConflictError);
    assert.equal(committed, true);
  });

  void test("nets prior reversals when allocating newly available payment and invoice balances", async () => {
    const priorApplication = {
      amount: 100,
      amountDecimal: "100.0000",
      reversals: [{ amountDecimal: "25.0000" }],
    };
    const store = transactionalStore({
      payment: { ...payment, applications: [priorApplication] },
      invoices: [
        {
          ...invoice,
          total: 100,
          totalDecimal: "100.0000",
          amountPaid: 75,
          amountPaidDecimal: "75.0000",
          applications: [priorApplication],
        },
      ],
    });
    const plan = await applyPaymentWithDependencies(
      "payment-1",
      [{ invoiceId: "invoice-1", amount: "25.0000" }],
      store
    );
    assert.equal(plan.paymentRemainingBefore, "25.0000");
    assert.equal(plan.applications[0]?.invoiceRemainingAfter, "0.0000");
    assert.equal(plan.paymentRemainingAfter, "0.0000");
    assert.equal(store.writes.length, 1);
  });
});

void describe("payment application reversal workflow", () => {
  void test("records partial and full exact reversals with a server-derived actor", async () => {
    const partialStore = reversalStore();
    const partial = await reversePaymentApplicationWithDependencies(
      "payment-1",
      "application-1",
      {
        amount: "25.0000",
        reason: "Duplicate application",
        accountingDate: "2026-09-22",
      },
      partialStore
    );
    assert.equal(partial.plan.invoiceAmountPaidAfter, "75.0000");
    assert.equal(partial.plan.invoiceStatusAfter, "POSTED");
    assert.equal(partialStore.writes[0]?.reversal.actor, PAYMENT_REVERSAL_ACTOR);
    assert.equal(partialStore.writes[0]?.reversal.amountDecimal, "25.0000");

    const fullStore = reversalStore();
    const full = await reversePaymentApplicationWithDependencies(
      "payment-1",
      "application-1",
      {
        amount: "100.0000",
        reason: "Wrong invoice",
        accountingDate: "2026-09-22",
      },
      fullStore
    );
    assert.equal(full.plan.invoiceAmountPaidAfter, "0.0000");
  });

  void test("restores SENT only when successful delivery evidence is persisted", async () => {
    const result = await reversePaymentApplicationWithDependencies(
      "payment-1",
      "application-1",
      {
        amount: "10.0000",
        reason: "Correction",
        accountingDate: "2026-09-22",
      },
      reversalStore(reversalSnapshot({ successfulDelivery: true }))
    );
    assert.equal(result.plan.invoiceStatusAfter, "SENT");
  });

  void test("rejects a closed period and a payment/application path mismatch", async () => {
    await assert.rejects(
      reversePaymentApplicationWithDependencies(
        "payment-1",
        "application-1",
        {
          amount: "10.0000",
          reason: "Correction",
          accountingDate: "2026-09-22",
        },
        reversalStore(
          reversalSnapshot({ closedThroughDate: "2026-09-22" })
        )
      ),
      (error) => {
        assert.ok(error instanceof PreconditionError);
        assert.equal(error.problem.code, "ACCOUNTING_PERIOD_CLOSED");
        return true;
      }
    );

    const wrongTarget = reversalSnapshot();
    await assert.rejects(
      reversePaymentApplicationWithDependencies(
        "payment-2",
        "application-1",
        {
          amount: "10.0000",
          reason: "Correction",
          accountingDate: "2026-09-22",
        },
        reversalStore(wrongTarget)
      ),
      (error) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.problem.code, "PAYMENT_APPLICATION_NOT_FOUND");
        return true;
      }
    );
  });

  void test("rejects invalid direct inputs and already-corrupt reversal totals", async () => {
    for (const amount of ["0.0000", "-1.0000"] as const) {
      await assert.rejects(
        reversePaymentApplicationWithDependencies(
          "payment-1",
          "application-1",
          {
            amount,
            reason: "Correction",
            accountingDate: "2026-09-22",
          },
          reversalStore()
        ),
        (error) => {
          assert.ok(error instanceof DomainInvariantError);
          assert.equal(error.problem.code, "PAYMENT_REVERSAL_INVALID");
          return true;
        }
      );
    }
    await assert.rejects(
      reversePaymentApplicationWithDependencies(
        "payment-1",
        "application-1",
        {
          amount: "1.0000",
          reason: "   ",
          accountingDate: "2026-09-22",
        },
        reversalStore()
      ),
      (error) => {
        assert.ok(error instanceof DomainInvariantError);
        assert.equal(error.problem.code, "PAYMENT_REVERSAL_INVALID");
        return true;
      }
    );
    await assert.rejects(
      reversePaymentApplicationWithDependencies(
        "payment-1",
        "application-1",
        {
          amount: "1.0000",
          reason: "Correction",
          accountingDate: "2026-09-22",
        },
        reversalStore(
          reversalSnapshot({
            reversedAmounts: ["101.0000"],
            amountPaidDecimal: "0.0000",
            amountPaid: 0,
            status: "POSTED",
          })
        )
      ),
      (error) => {
        assert.ok(error instanceof DomainInvariantError);
        assert.equal(error.problem.code, "PAYMENT_REVERSAL_INVALID");
        return true;
      }
    );
  });

  void test("allows only one of two stale reversals to commit", async () => {
    let amountPaid = "100.0000";
    let reversedAmounts: string[] = [];
    let readers = 0;
    let releaseReads: (() => void) | undefined;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const store: PaymentReversalDependencies = {
      async transaction(operation) {
        return operation({
          async loadApplication() {
            const snapshot = reversalSnapshot({
              reversedAmounts: [...reversedAmounts],
              amountPaidDecimal: amountPaid,
              amountPaid: Number(amountPaid),
              status: amountPaid === "100.0000" ? "PAID" : "POSTED",
            });
            readers += 1;
            if (readers === 2) releaseReads?.();
            if (readers <= 2) await bothRead;
            return snapshot;
          },
          async persistReversal({ reversal, invoice: invoiceWrite }) {
            if (invoiceWrite.expectedAmountPaidDecimal !== amountPaid) return false;
            reversedAmounts = [...reversedAmounts, reversal.amountDecimal];
            amountPaid = invoiceWrite.amountPaidDecimal;
            return true;
          },
        });
      },
    };
    const results = await Promise.allSettled([
      reversePaymentApplicationWithDependencies(
        "payment-1",
        "application-1",
        {
          amount: "75.0000",
          reason: "First correction",
          accountingDate: "2026-09-22",
        },
        store
      ),
      reversePaymentApplicationWithDependencies(
        "payment-1",
        "application-1",
        {
          amount: "75.0000",
          reason: "Second correction",
          accountingDate: "2026-09-22",
        },
        store
      ),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    assert.deepEqual(reversedAmounts, ["75.0000"]);
    assert.equal(amountPaid, "25.0000");
    const rejected = results.find(({ status }) => status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof DomainInvariantError);
    assert.equal(rejected.reason.problem.code, "PAYMENT_REVERSAL_INVALID");
  });
});
