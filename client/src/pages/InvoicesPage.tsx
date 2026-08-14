import { useEffect, useState } from "react";
import { apiGet, money, shortDate } from "../api";
import { Card, PageHeader, StatTile, StatusBadge } from "../components";
import { navigate } from "../router";
import type { Invoice } from "../types";

export function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Invoice[]>("/invoices").then(setInvoices).catch((e) => setError(e.message));
  }, []);

  const outstanding = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
  const collected = invoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0);
  const overdue = invoices.filter(
    (invoice) => invoice.balance > 0 && new Date(invoice.dueDate) < new Date()
  );

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="Draft invoices follow their order until they are posted."
      />
      <div className="stat-row">
        <StatTile label="Outstanding balance" value={money(outstanding)} />
        <StatTile
          label="Overdue"
          value={String(overdue.length)}
          hint={`${money(overdue.reduce((sum, invoice) => sum + invoice.balance, 0))} past due`}
        />
        <StatTile label="Collected" value={money(collected)} />
      </div>
      {error && <div className="banner error">{error}</div>}
      <Card flush>
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Issued</th>
              <th>Due</th>
              <th>Status</th>
              <th>Transmission</th>
              <th className="num">Total</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr
                key={invoice.id}
                className="clickable"
                onClick={() => navigate(`/invoices/${invoice.id}`)}
              >
                <td className="strong">{invoice.number}</td>
                <td>{invoice.customerName}</td>
                <td>{shortDate(invoice.issueDate)}</td>
                <td>{shortDate(invoice.dueDate)}</td>
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
                <td>
                  {invoice.lastTransmission ? (
                    <>
                      <span className="muted">{invoice.lastTransmission.method}</span>{" "}
                      <StatusBadge status={invoice.lastTransmission.status} />
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">{money(invoice.total)}</td>
                <td className="num">{money(invoice.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
