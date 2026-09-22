import { useEffect, useState } from "react";
import { apiGet, apiPost, errorMessage, money, shortDate } from "../api";
import { Card, EmptyState, Modal, PageHeader, StatTile, StatusBadge } from "../components";
import { navigate } from "../router";
import type { Customer, Invoice, Payment } from "../types";

export function CashApplicationPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [openPaymentId, setOpenPaymentId] = useState<string | null>(null);
  const [applyAmounts, setApplyAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    apiGet<Invoice[]>("/invoices")
      .then(setInvoices)
      .catch((error) => setError(errorMessage(error)));
    apiGet<Payment[]>("/payments")
      .then(setPayments)
      .catch((error) => setError(errorMessage(error)));
    apiGet<Customer[]>("/customers")
      .then(setCustomers)
      .catch((error) => setError(errorMessage(error)));
  };
  useEffect(load, []);

  const outstanding = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
  const unappliedCash = payments.reduce((sum, payment) => sum + payment.unapplied, 0);
  const received = payments.reduce((sum, payment) => sum + payment.amount, 0);

  const record = async () => {
    setError(null);
    setMessage(null);
    try {
      const payment = await apiPost<Payment>("/payments", {
        customerId,
        amount,
        reference: reference || undefined,
      });
      setMessage(`Recorded ${money(payment.amount)} from ${payment.customerName}.`);
      setAmount("");
      setReference("");
      load();
      setApplyAmounts({});
      setOpenPaymentId(payment.id);
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  const openPayment = payments.find((payment) => payment.id === openPaymentId) ?? null;
  const openInvoices = openPayment
    ? invoices.filter(
        (invoice) => invoice.customerId === openPayment.customerId && invoice.balance > 0
      )
    : [];
  const applyTotal = Object.values(applyAmounts).reduce((sum, v) => sum + (Number(v) || 0), 0);

  const applyPayment = async () => {
    if (!openPayment) return;
    setError(null);
    setMessage(null);
    const applications = Object.entries(applyAmounts)
      .filter(([, value]) => /[1-9]/.test(value))
      .map(([invoiceId, value]) => ({ invoiceId, amount: value }));
    try {
      const updated = await apiPost<Payment>(`/payments/${openPayment.id}/apply`, {
        applications,
      });
      setMessage(
        `Applied ${money(applyTotal)} from ${
          updated.customerName
        } — ${money(updated.unapplied)} remains unapplied.`
      );
      setApplyAmounts({});
      setOpenPaymentId(null);
      load();
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  return (
    <div>
      <PageHeader
        title="Cash Application"
        subtitle="Record incoming payments, then apply them across open invoices."
      />
      <div className="stat-row">
        <StatTile label="Outstanding A/R" value={money(outstanding)} />
        <StatTile label="Unapplied cash" value={money(unappliedCash)} />
        <StatTile label="Cash received" value={money(received)} />
      </div>

      {error && <div className="banner error">{error}</div>}
      {message && <div className="banner ok">{message}</div>}

      <Card title="Record a payment">
        <div className="field-grid">
          <label className="field">
            <span>Customer</span>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select a customer…</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount received</span>
            <input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Reference</span>
            <input
              placeholder="ACH / wire / check #"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button className="btn primary" disabled={!customerId || !amount} onClick={record}>
              Record payment
            </button>
          </div>
        </div>
      </Card>

      <Card title="Payments" flush>
        {payments.length === 0 ? (
          <EmptyState>No payments recorded.</EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Customer</th>
                <th>Reference</th>
                <th className="num">Amount</th>
                <th className="num">Applied</th>
                <th className="num">Unapplied</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr
                  key={payment.id}
                  className="clickable"
                  onClick={() => {
                    setApplyAmounts({});
                    setOpenPaymentId(payment.id);
                  }}
                >
                  <td>{shortDate(payment.receivedAt)}</td>
                  <td className="strong">{payment.customerName}</td>
                  <td className="muted">{payment.reference ?? "—"}</td>
                  <td className="num">{money(payment.amount)}</td>
                  <td className="num">{money(payment.applied)}</td>
                  <td className="num">{money(payment.unapplied)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Invoices & balances" flush>
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Issued</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th className="num">Paid</th>
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
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
                <td className="num">{money(invoice.total)}</td>
                <td className="num">{money(invoice.amountPaid)}</td>
                <td className="num">{money(invoice.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {openPayment && (
        <Modal
          title={`Payment from ${openPayment.customerName}`}
          onClose={() => setOpenPaymentId(null)}
          footer={
            <>
              <button className="btn" onClick={() => setOpenPaymentId(null)}>
                Close
              </button>
              {openPayment.unapplied !== 0 && (
                <button className="btn primary" disabled={applyTotal <= 0} onClick={applyPayment}>
                  Apply {money(applyTotal)}
                </button>
              )}
            </>
          }
        >
          <div className="modal-stats">
            <div className="mini">
              <div className="stat-label">Received</div>
              <div className="stat-value">{shortDate(openPayment.receivedAt)}</div>
            </div>
            <div className="mini">
              <div className="stat-label">Reference</div>
              <div className="stat-value">{openPayment.reference ?? "—"}</div>
            </div>
            <div className="mini">
              <div className="stat-label">Amount</div>
              <div className="stat-value">{money(openPayment.amount)}</div>
            </div>
            <div className="mini">
              <div className="stat-label">Unapplied</div>
              <div className="stat-value">{money(openPayment.unapplied)}</div>
            </div>
          </div>

          <div className="modal-section">Applied to</div>
          {openPayment.applications.length === 0 ? (
            <EmptyState>Not applied to any invoices yet.</EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Applied on</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {openPayment.applications.map((application) => (
                  <tr key={application.id}>
                    <td className="strong">
                      <a href={`#/invoices/${application.invoiceId}`}>
                        {application.invoiceNumber}
                      </a>
                    </td>
                    <td>{shortDate(application.appliedAt)}</td>
                    <td className="num">{money(application.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {openPayment.unapplied !== 0 && (
            <>
              <div className="modal-section">
                Apply remaining {money(openPayment.unapplied)} — open invoices
              </div>
              {openInvoices.length === 0 ? (
                <EmptyState>No open invoices for this customer.</EmptyState>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Status</th>
                      <th className="num">Balance</th>
                      <th className="num">Apply amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openInvoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="strong">{invoice.number}</td>
                        <td>
                          <StatusBadge status={invoice.status} />
                        </td>
                        <td className="num">{money(invoice.balance)}</td>
                        <td className="num">
                          <input
                            aria-label={`Amount to apply to ${invoice.number}`}
                            className="qty"
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            value={applyAmounts[invoice.id] ?? ""}
                            onChange={(e) =>
                              setApplyAmounts({ ...applyAmounts, [invoice.id]: e.target.value })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
