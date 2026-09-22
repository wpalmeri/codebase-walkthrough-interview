import { useEffect, useState } from "react";
import {
  apiGet,
  errorMessage,
  financialValue,
  isPositiveMoney,
  money,
  shortDate,
  sumMoney,
} from "../api";
import { Card, PageHeader, StatTile, StatusBadge } from "../components";
import { navigate } from "../router";
import type { Invoice } from "../types";

export function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Invoice[]>("/invoices")
      .then(setInvoices)
      .catch((error) => setError(errorMessage(error)));
  }, []);

  const outstanding = sumMoney(
    invoices.map((invoice) => financialValue(invoice.balanceDecimal, invoice.balance))
  );
  const collected = sumMoney(
    invoices.map((invoice) => financialValue(invoice.amountPaidDecimal, invoice.amountPaid))
  );
  const overdue = invoices.filter(
    (invoice) =>
      isPositiveMoney(financialValue(invoice.balanceDecimal, invoice.balance)) &&
      new Date(invoice.dueDate) < new Date()
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
          hint={`${money(
            sumMoney(
              overdue.map((invoice) => financialValue(invoice.balanceDecimal, invoice.balance))
            )
          )} past due`}
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
                <td className="num">{money(financialValue(invoice.totalDecimal, invoice.total))}</td>
                <td className="num">{money(financialValue(invoice.balanceDecimal, invoice.balance))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
