import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  summarizeAnnualRevenue,
  summarizeRevenueByCustomer,
  summarizeRevenueByQuarter,
  toRecognizedRevenueRows,
  type ReportableInvoice,
} from "./reportController";

function invoice(
  status: string,
  total: number,
  issueDate = new Date(2026, 0, 15),
  customerId = "customer-1",
  customerName = "Acme"
): ReportableInvoice {
  return {
    status,
    total,
    issueDate,
    customerId,
    customer: { name: customerName },
  };
}

void describe("revenue reports", () => {
  void it("recognizes posted, sent, and paid invoices but excludes draft and void invoices", () => {
    const rows = toRecognizedRevenueRows([
      invoice("DRAFT", 10),
      invoice("POSTED", 20),
      invoice("SENT", 30),
      invoice("PAID", 40),
      invoice("VOID", 50),
    ]);

    assert.deepEqual(
      rows.map((row) => row.revenue),
      [20, 30, 40]
    );
  });

  void it("uses the materialized invoice total, including invoice-level adjustments", () => {
    // A 100 subtotal with a 15 discount and 5 tax has a final invoice total of 90.
    const [row] = toRecognizedRevenueRows([invoice("POSTED", 90)]);

    assert.equal(row?.revenue, 90);
  });

  void it("does not require live order or product records to retain revenue", () => {
    const rows = toRecognizedRevenueRows([invoice("POSTED", 125)]);

    assert.deepEqual(rows, [
      {
        issueDate: new Date(2026, 0, 15),
        customerId: "customer-1",
        customerName: "Acme",
        revenue: 125,
      },
    ]);
  });

  void it("groups recognized totals and emits empty quarters inside the requested period", () => {
    const rows = toRecognizedRevenueRows([
      invoice("POSTED", 100, new Date(2026, 0, 15)),
      invoice("SENT", 50, new Date(2026, 6, 15)),
    ]);

    assert.deepEqual(
      summarizeRevenueByQuarter(rows, { from: "2026-01-01", to: "2026-09-30" }),
      [
        { quarter: "2026-Q1", invoiceCount: 1, revenue: 100 },
        { quarter: "2026-Q2", invoiceCount: 0, revenue: 0 },
        { quarter: "2026-Q3", invoiceCount: 1, revenue: 50 },
      ]
    );
  });

  void it("groups customers by stable id and sorts them by descending revenue", () => {
    const rows = toRecognizedRevenueRows([
      invoice("POSTED", 50, new Date(2026, 0, 1), "customer-1", "Same Name"),
      invoice("PAID", 75, new Date(2026, 0, 2), "customer-2", "Same Name"),
      invoice("SENT", 10, new Date(2026, 0, 3), "customer-1", "Same Name"),
    ]);

    assert.deepEqual(summarizeRevenueByCustomer(rows), [
      { customerId: "customer-2", customerName: "Same Name", invoiceCount: 1, revenue: 75 },
      { customerId: "customer-1", customerName: "Same Name", invoiceCount: 2, revenue: 60 },
    ]);
  });

  void it("groups annual revenue and emits empty years inside the requested period", () => {
    const rows = toRecognizedRevenueRows([
      invoice("POSTED", 100, new Date(2025, 0, 1)),
      invoice("PAID", 200, new Date(2027, 0, 1)),
    ]);

    assert.deepEqual(
      summarizeAnnualRevenue(rows, { from: "2025-01-01", to: "2027-12-31" }),
      [
        { year: 2025, invoiceCount: 1, revenue: 100 },
        { year: 2026, invoiceCount: 0, revenue: 0 },
        { year: 2027, invoiceCount: 1, revenue: 200 },
      ]
    );
  });
});
