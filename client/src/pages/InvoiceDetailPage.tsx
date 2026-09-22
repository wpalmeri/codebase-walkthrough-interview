import { useEffect, useState } from "react";
import {
  apiGet,
  apiPost,
  apiPut,
  decimalDisplay,
  dateTime,
  errorMessage,
  financialValue,
  money,
  shortDate,
} from "../api";
import { Card, EmptyState, PageHeader, StatusBadge } from "../components";
import type { Invoice } from "../types";

export function InvoiceDetailPage({ invoiceId }: { invoiceId: string }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState("EMAIL");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    apiGet<Invoice>(`/invoices/${invoiceId}`)
      .then((row) => {
        setInvoice(row);
        setIssueDate(row.issueDate.slice(0, 10));
        setDueDate(row.dueDate.slice(0, 10));
      })
      .catch((error) => setError(errorMessage(error)));
  };
  useEffect(load, [invoiceId]);

  if (!invoice) {
    return error ? <div className="banner error">{error}</div> : null;
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        crumbs={[{ label: "Invoices", to: "/invoices" }, { label: invoice.number }]}
        title={invoice.number}
        titleExtra={<StatusBadge status={invoice.status} />}
        subtitle={`${invoice.customerName} · issued ${shortDate(invoice.issueDate)} · due ${shortDate(invoice.dueDate)}`}
        actions={
          <>
            {invoice.status === "DRAFT" && (
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => act(() => apiPost(`/invoices/${invoice.id}/post`))}
              >
                Post invoice
              </button>
            )}
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="EMAIL">Email</option>
              <option value="PORTAL">Portal upload</option>
              <option value="API">Clearinghouse API</option>
            </select>
            <button
              className="btn"
              disabled={busy}
              onClick={() => act(() => apiPost(`/invoices/${invoice.id}/send`, { method }))}
            >
              Send
            </button>
          </>
        }
      />

      {error && <div className="banner error">{error}</div>}
      {invoice.status === "DRAFT" && (
        <div className="banner warn">
          <div>
            <strong>Draft.</strong> This invoice follows its order — totals update when the
            order changes. Post it to finalize pricing.
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div>
          <Card title="Lines" flush>
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Quantity</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.description}</td>
                    <td className="num">{decimalDisplay(line.quantityDecimal ?? line.quantity)}</td>
                    <td className="num">{money(financialValue(line.unitPriceDecimal, line.unitPrice))}</td>
                    <td className="num">{money(financialValue(line.amountDecimal, line.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="totals">
              <div className="totals-row">
                <span className="t-label">Subtotal</span>
                <span className="t-value">{money(financialValue(invoice.totalDecimal, invoice.total))}</span>
              </div>
              <div className="totals-row">
                <span className="t-label">Amount paid</span>
                <span className="t-value">{money(financialValue(invoice.amountPaidDecimal, invoice.amountPaid))}</span>
              </div>
              <div className="totals-row grand">
                <span className="t-label">Balance due</span>
                <span className="t-value">{money(financialValue(invoice.balanceDecimal, invoice.balance))}</span>
              </div>
            </div>
          </Card>

          <Card
            title="Payments"
            actions={<a href="#/cash-application">Record a payment →</a>}
            flush
          >
            {invoice.payments.length === 0 ? (
              <EmptyState>No payments applied.</EmptyState>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Reference</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td>{shortDate(payment.receivedAt)}</td>
                      <td>{payment.reference ?? <span className="muted">—</span>}</td>
                      <td className="num">{money(financialValue(payment.amountDecimal, payment.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Transmissions" flush>
            {invoice.transmissions.length === 0 ? (
              <EmptyState>Not yet transmitted to the customer.</EmptyState>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Sent</th>
                    <th>Method</th>
                    <th>Status</th>
                    <th>External job</th>
                    <th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.transmissions.map((tx) => (
                    <tr key={tx.id}>
                      <td>{dateTime(tx.createdAt)}</td>
                      <td>{tx.method}</td>
                      <td>
                        <StatusBadge status={tx.status} />
                      </td>
                      <td className="muted">{tx.externalJobId ?? "—"}</td>
                      <td className="num">
                        {tx.method === "PORTAL" && tx.status !== "DELIVERED" && (
                          <button
                            className="btn sm"
                            disabled={busy}
                            onClick={() =>
                              act(() => apiPost(`/invoices/transmissions/${tx.id}/refresh`))
                            }
                          >
                            Check status
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div>
          <Card title="Details">
            <div className="meta-list">
              <div className="meta-item">
                <div className="meta-label">Invoice number</div>
                <div className="meta-value">{invoice.number}</div>
              </div>
              <div className="meta-item">
                <div className="meta-label">Source order</div>
                <div className="meta-value">
                  <a href={`#/orders/${invoice.orderId}`}>
                    {invoice.orderReference ?? invoice.orderId}
                  </a>
                </div>
              </div>
              <div className="meta-item">
                <div className="meta-label">Issued</div>
                <div className="meta-value">
                  <input
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="meta-item">
                <div className="meta-label">Due</div>
                <div className="meta-value">
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </div>
              </div>
              {(issueDate !== invoice.issueDate.slice(0, 10) ||
                dueDate !== invoice.dueDate.slice(0, 10)) && (
                <div className="meta-item">
                  <button
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() =>
                      act(() => apiPut(`/invoices/${invoice.id}`, { issueDate, dueDate }))
                    }
                  >
                    Save dates
                  </button>
                </div>
              )}
              <div className="meta-item">
                <div className="meta-label">Posted</div>
                <div className="meta-value">
                  {invoice.postedAt ? dateTime(invoice.postedAt) : <span className="muted">Not posted</span>}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Bill to">
            <div className="meta-list">
              <div className="meta-item">
                <div className="meta-value">{invoice.customerName}</div>
                <div className="meta-value muted">{invoice.customerEmail}</div>
                <div className="meta-value muted">{invoice.billingAddress}</div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
