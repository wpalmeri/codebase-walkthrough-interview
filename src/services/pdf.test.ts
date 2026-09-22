import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { renderInvoicePdf, type PdfInvoice } from "./pdf";

function invoice(lines = 1): PdfInvoice {
  return {
    number: "INV-DETERMINISTIC",
    customerName: "Example (North) \\ Holdings",
    billingAddress: "1 Exact Way",
    issueDate: new Date("2026-09-22T23:30:00.000Z"),
    dueDate: new Date("2026-10-22T23:30:00.000Z"),
    total: 999,
    totalDecimal: "0.3000",
    lines: Array.from({ length: lines }, (_, index) => ({
      description: `Usage line ${index + 1}`,
      quantity: 999,
      quantityDecimal: "3.000000",
      unitPrice: 999,
      unitPriceDecimal: "0.1000",
      amount: 999,
      amountDecimal: "0.3000",
    })),
  };
}

void describe("invoice PDF rendering", () => {
  void test("emits a deterministic PDF using exact snapshot amounts", () => {
    const first = renderInvoicePdf(invoice());
    const second = renderInvoicePdf(invoice());
    const text = first.toString("ascii");

    assert.deepEqual(first, second);
    assert.match(text, /^%PDF-1\.4/u);
    assert.match(text, /\/Type \/Catalog/u);
    assert.ok(text.includes("Example \\(North\\) \\\\ Holdings"));
    assert.match(text, /3\s+0\.1000\s+0\.3000/u);
    assert.match(text, /TOTAL DUE\s+0\.3000/u);
    const startXref = Number(/startxref\n(\d+)\n%%EOF/u.exec(text)?.[1]);
    assert.equal(text.slice(startXref, startXref + 4), "xref");
    assert.equal(createHash("sha256").update(first).digest("hex").length, 64);
  });

  void test("renders thousands of lines across pages without a fixed-buffer failure", () => {
    const document = renderInvoicePdf(invoice(5_000));
    const text = document.toString("ascii");

    assert.ok(document.length > 64 * 1024);
    assert.match(text, /\/Type \/Pages \/Count 132/u);
    assert.match(text, /Usage line 5000/u);
    assert.match(text, /%%EOF\n$/u);
  });

  void test("rejects a corrupt exact amount instead of falling back to the legacy float", () => {
    const corrupt = invoice();
    corrupt.lines[0].amountDecimal = "not-money";
    assert.throws(() => renderInvoicePdf(corrupt), /must be a decimal/);
  });
});
