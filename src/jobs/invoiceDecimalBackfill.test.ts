import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prepareInvoiceDecimalBackfill, type InvoiceDecimalBackfillSource } from "./invoiceDecimalBackfill";

const issueDate = new Date("2026-02-28T23:30:00-08:00");

function source(): InvoiceDecimalBackfillSource {
  return {
    id: "invoice-1",
    beforeAmount: "0.3000",
    issueDate,
    accountingDate: null,
    total: 0.3,
    totalDecimal: null,
    amountPaid: 0.1,
    amountPaidDecimal: null,
    lines: [
      {
        id: "line-1",
        quantity: 3,
        quantityDecimal: null,
        unitPrice: 0.1,
        unitPriceDecimal: null,
        amount: 0.3,
        amountDecimal: null,
      },
    ],
    applications: [{ amount: 0.1, amountDecimal: null }],
  };
}

void describe("invoice Decimal backfill preparation", () => {
  void test("produces exact idempotent writes and a UTC accounting date from reconciled legacy facts", () => {
    const prepared = prepareInvoiceDecimalBackfill(source());
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;
    assert.deepEqual(prepared.write, {
      invoiceId: "invoice-1",
      accountingDate: "2026-03-01",
      totalDecimal: "0.3000",
      amountPaidDecimal: "0.1000",
      lines: [
        {
          id: "line-1",
          quantityDecimal: "3.000000",
          unitPriceDecimal: "0.1000",
          amountDecimal: "0.3000",
        },
      ],
    });

    const alreadyExact = source();
    alreadyExact.totalDecimal = "0.3000";
    alreadyExact.amountPaidDecimal = "0.1000";
    alreadyExact.accountingDate = "2026-03-01";
    alreadyExact.lines[0].quantityDecimal = "3.000000";
    alreadyExact.lines[0].unitPriceDecimal = "0.1000";
    alreadyExact.lines[0].amountDecimal = "0.3000";
    alreadyExact.applications[0].amountDecimal = "0.1000";
    assert.deepEqual(prepareInvoiceDecimalBackfill(alreadyExact), prepared);
  });

  void test("stops when line totals cannot explain the invoice total", () => {
    const input = source();
    input.lines[0].amount = 0.2;
    assert.deepEqual(prepareInvoiceDecimalBackfill(input), {
      kind: "unsafe",
      code: "UNMODELED_INVOICE_ADJUSTMENT",
      detail: "Invoice invoice-1 line total 0.2000 does not explain total 0.3000",
    });
  });

  void test("stops when immutable applications do not explain stored amount paid", () => {
    const input = source();
    input.applications = [];
    assert.deepEqual(prepareInvoiceDecimalBackfill(input), {
      kind: "unsafe",
      code: "UNRECONCILED_PAYMENT_APPLICATIONS",
      detail: "Invoice invoice-1 applications 0.0000 do not explain amount paid 0.1000",
    });
  });

  void test("stops instead of rounding an unrepresentable legacy float", () => {
    const input = source();
    input.total = 0.30000000000000004;
    const result = prepareInvoiceDecimalBackfill(input);
    assert.equal(result.kind, "unsafe");
    if (result.kind !== "unsafe") return;
    assert.equal(result.code, "UNREPRESENTABLE_LEGACY_DECIMAL");
    assert.match(result.detail, /at most 4 decimal places/);
  });
});
