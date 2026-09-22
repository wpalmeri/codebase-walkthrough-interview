import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  prepareInvoiceSnapshotBackfill,
  type InvoiceSnapshotBackfillSource,
} from "./invoiceSnapshotBackfill";

function source(status = "POSTED"): InvoiceSnapshotBackfillSource {
  return {
    id: "invoice-1",
    beforeAmount: "0.0000",
    status,
    customerNameSnapshot: status === "DRAFT" ? null : "Historical Customer",
    customerEmailSnapshot: status === "DRAFT" ? null : "historical@example.com",
    billingAddressSnapshot: null,
    customer: {
      name: "Current Customer",
      email: "current@example.com",
      billingAddress: "Current address",
    },
    lines: [
      {
        id: "line-1",
        description: "Historical Product @ seat",
        productSkuSnapshot: null,
        productUnitSnapshot: null,
        quantityDecimal: "2.000000",
        unitPriceDecimal: "4.5000",
        amountDecimal: "9.0000",
      },
    ],
    orderItems: [
      {
        id: "item-1",
        productSkuSnapshot: "HISTORICAL-SKU",
        productNameSnapshot: "Historical Product",
        productUnitSnapshot: "seat",
        quantityDecimal: "2.000000",
        unitPriceDecimal: "4.5000",
        amountDecimal: "9.0000",
      },
    ],
  };
}

void describe("invoice snapshot backfill preparation", () => {
  void test("fills a finalized line only from unique captured order evidence", () => {
    const result = prepareInvoiceSnapshotBackfill(source());
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;
    assert.equal(result.write.customerNameSnapshot, "Historical Customer");
    assert.equal(result.write.customerEmailSnapshot, "historical@example.com");
    assert.equal(result.write.billingAddressSnapshot, null);
    assert.deepEqual(result.write.lines, [
      {
        id: "line-1",
        productSkuSnapshot: "HISTORICAL-SKU",
        productUnitSnapshot: "seat",
      },
    ]);
  });

  void test("allows an unissued draft to take current bill-to identity", () => {
    const result = prepareInvoiceSnapshotBackfill(source("DRAFT"));
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;
    assert.equal(result.write.customerNameSnapshot, "Current Customer");
    assert.equal(result.write.customerEmailSnapshot, "current@example.com");
    assert.equal(result.write.billingAddressSnapshot, "Current address");
  });

  void test("refuses mutable customer data as evidence for a finalized invoice", () => {
    const missing = {
      ...source(),
      customerNameSnapshot: null,
      customerEmailSnapshot: null,
    };
    const result = prepareInvoiceSnapshotBackfill(missing);
    assert.equal(result.kind, "unsafe");
    if (result.kind === "unsafe") {
      assert.equal(result.code, "MISSING_FINALIZED_BILL_TO_EVIDENCE");
      assert.doesNotMatch(result.detail, /current@example/);
    }
  });

  void test("refuses ambiguous and conflicting line identity evidence", () => {
    const base = source();
    const ambiguous = {
      ...base,
      lines: [
        ...base.lines,
        { ...base.lines[0], id: "line-2" },
      ],
      orderItems: [
        ...base.orderItems,
        { ...base.orderItems[0], id: "item-2" },
      ],
    };
    const ambiguousResult = prepareInvoiceSnapshotBackfill(ambiguous);
    assert.equal(ambiguousResult.kind, "unsafe");
    if (ambiguousResult.kind === "unsafe") {
      assert.equal(ambiguousResult.code, "AMBIGUOUS_INVOICE_LINE_EVIDENCE");
    }

    const conflicting = {
      ...base,
      lines: base.lines.map((line) => ({ ...line, productSkuSnapshot: "WRONG-SKU" })),
    };
    const conflictingResult = prepareInvoiceSnapshotBackfill(conflicting);
    assert.equal(conflictingResult.kind, "unsafe");
    if (conflictingResult.kind === "unsafe") {
      assert.equal(conflictingResult.code, "CONFLICTING_INVOICE_SNAPSHOT");
    }
  });
});
