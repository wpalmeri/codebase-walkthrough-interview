import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_PAYMENT_CURRENCY,
  PaymentAllocationConflictError,
  applyPaymentWithDependencies,
  createPaymentWithDependencies,
  type InvoiceLedgerSnapshot,
  type PaymentAllocationDependencies,
  type PaymentLedgerSnapshot,
} from "./paymentController";
import { DomainInvariantError, NotFoundError } from "../errors";

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
});
