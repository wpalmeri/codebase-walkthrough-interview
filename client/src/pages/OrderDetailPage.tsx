import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPut, dateTime, errorMessage, money, shortDate } from "../api";
import { Card, EmptyState, PageHeader, StatusBadge, icons } from "../components";
import { navigate } from "../router";
import type { Customer, Order } from "../types";

const CURRENT_USER = "a.reyes";

export function OrderDetailPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    apiGet<Order>(`/orders/${orderId}`)
      .then((row) => {
        setOrder(row);
        setNotes(row.notes ?? "");
        setOrderDate(row.orderDate.slice(0, 10));
        setCustomerId(row.customerId);
        setQty(Object.fromEntries(row.items.map((item) => [item.id, String(item.quantity)])));
      })
      .catch((error) => setError(errorMessage(error)));
  };
  useEffect(load, [orderId]);
  useEffect(() => {
    apiGet<Customer[]>("/customers")
      .then(setCustomers)
      .catch((error) => setError(errorMessage(error)));
  }, []);

  if (!order) {
    return error ? <div className="banner error">{error}</div> : null;
  }

  // Orders with a posted invoice can no longer be changed — comments only.
  const locked = !!order.invoiceStatus && order.invoiceStatus !== "DRAFT";
  const dirty =
    notes !== (order.notes ?? "") ||
    orderDate !== order.orderDate.slice(0, 10) ||
    customerId !== order.customerId ||
    order.items.some((item) => Number(qty[item.id]) !== item.quantity);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setSaving(true);
    try {
      await fn();
      load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const saveChanges = () =>
    act(() =>
      apiPut(`/orders/${order.id}`, {
        customerId,
        orderDate,
        notes,
        items: order.items.map((item) => ({ id: item.id, quantity: qty[item.id] })),
      })
    );

  const addComment = (): void => {
    const body = comment.trim();
    if (!body) return;
    setComment("");
    void act(() =>
      apiPut(`/orders/${order.id}`, { comment: { author: CURRENT_USER, body } })
    );
  };

  const generateInvoice = () =>
    act(async () => {
      const invoice = await apiPost<{ id: string }>(`/orders/${order.id}/invoice`);
      navigate(`/invoices/${invoice.id}`);
    });

  return (
    <div>
      <PageHeader
        crumbs={[{ label: "Orders", to: "/orders" }, { label: order.reference ?? order.id }]}
        title={order.reference ?? order.id}
        titleExtra={<StatusBadge status={order.status} />}
        subtitle={`${order.customerName} · ordered ${shortDate(order.orderDate)}`}
        actions={
          <>
            {!locked && (
              <button className="btn primary" disabled={!dirty || saving} onClick={saveChanges}>
                Save changes
              </button>
            )}
            {!order.invoiceId && (
              <button className="btn" disabled={saving} onClick={generateInvoice}>
                Generate invoice
              </button>
            )}
          </>
        }
      />

      {error && <div className="banner error">{error}</div>}
      {locked && (
        <div className="banner warn">
          {icons.lock}
          <div>
            <strong>This order is locked.</strong> Invoice {order.invoiceNumber} has been
            posted, so line items and notes can no longer be changed. You can still add
            comments below.
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div>
          <Card title="Line items" flush>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th className="num">Quantity</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td className="strong">{item.productName}</td>
                    <td className="muted">{item.productSku}</td>
                    <td className="num">
                      {locked ? (
                        <span className="mono">{item.quantity}</span>
                      ) : (
                        <input
                          className="qty"
                          type="number"
                          value={qty[item.id] ?? ""}
                          onChange={(e) => setQty({ ...qty, [item.id]: e.target.value })}
                        />
                      )}
                    </td>
                    <td className="num">{money(item.unitPrice)}</td>
                    <td className="num">{money(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="totals">
              <div className="totals-row grand">
                <span className="t-label">Order total</span>
                <span className="t-value">{money(order.total)}</span>
              </div>
            </div>
          </Card>

          <Card title={`Comments (${order.comments.length})`}>
            {order.comments.length === 0 && <EmptyState>No comments yet.</EmptyState>}
            {order.comments.map((c) => (
              <div className="comment" key={c.id}>
                <div className="avatar">{c.author.slice(0, 2).toUpperCase()}</div>
                <div className="comment-body">
                  <div className="comment-head">
                    <span className="author">{c.author}</span>
                    <span className="when">{dateTime(c.createdAt)}</span>
                  </div>
                  <div className="comment-text">{c.body}</div>
                </div>
              </div>
            ))}
            <div className="comment-form">
              <input
                placeholder="Add a comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addComment();
                }}
              />
              <button className="btn" disabled={!comment.trim() || saving} onClick={addComment}>
                Comment
              </button>
            </div>
          </Card>
        </div>

        <div>
          <Card title="Details">
            <div className="meta-list">
              <div className="meta-item">
                <div className="meta-label">Reference</div>
                <div className="meta-value">{order.reference ?? order.id}</div>
              </div>
              <div className="meta-item">
                <div className="meta-label">Customer</div>
                <div className="meta-value">
                  {locked ? (
                    order.customerName
                  ) : (
                    <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              <div className="meta-item">
                <div className="meta-label">Order date</div>
                <div className="meta-value">
                  {locked ? (
                    shortDate(order.orderDate)
                  ) : (
                    <input
                      type="date"
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value)}
                    />
                  )}
                </div>
              </div>
              <div className="meta-item">
                <div className="meta-label">Invoice</div>
                <div className="meta-value">
                  {order.invoiceId ? (
                    <>
                      <a href={`#/invoices/${order.invoiceId}`}>{order.invoiceNumber}</a>{" "}
                      <StatusBadge status={order.invoiceStatus} />
                    </>
                  ) : (
                    <span className="muted">Not invoiced</span>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Billing party">
            <div className="meta-list">
              <div className="meta-item">
                <div className="meta-value">{order.customerName}</div>
                <div className="meta-value muted">{order.customerEmail}</div>
                <div className="meta-value muted">{order.billingAddress}</div>
              </div>
            </div>
          </Card>

          <Card title="Receiver">
            <div className="meta-value">
              {order.shipTo ?? <span className="muted">Same as billing party</span>}
            </div>
          </Card>

          <Card title="Notes">
            <textarea
              rows={3}
              disabled={locked}
              placeholder="Internal notes for this order…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
