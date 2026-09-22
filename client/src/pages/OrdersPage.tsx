import { useEffect, useState } from "react";
import { apiGet, errorMessage, financialValue, money, shortDate, sumMoney } from "../api";
import { Card, PageHeader, StatTile, StatusBadge } from "../components";
import { navigate } from "../router";
import type { Order } from "../types";

export function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Order[]>("/orders")
      .then(setOrders)
      .catch((error) => setError(errorMessage(error)));
  }, []);

  const openOrders = orders.filter((order) => !order.invoiceId);
  const openValue = sumMoney(
    openOrders.map((order) => financialValue(order.totalDecimal, order.total))
  );
  const invoicedValue = sumMoney(
    orders
      .filter((order) => order.invoiceId)
      .map((order) => financialValue(order.totalDecimal, order.total))
  );

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Sales orders priced from each customer's rate agreement."
      />
      <div className="stat-row">
        <StatTile label="Orders" value={String(orders.length)} />
        <StatTile
          label="Awaiting invoice"
          value={String(openOrders.length)}
          hint={`${money(openValue)} uninvoiced`}
        />
        <StatTile label="Invoiced value" value={money(invoicedValue)} />
      </div>
      {error && <div className="banner error">{error}</div>}
      <Card flush>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Order date</th>
              <th>Status</th>
              <th>Invoice</th>
              <th className="num">Items</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr
                key={order.id}
                className="clickable"
                onClick={() => navigate(`/orders/${order.id}`)}
              >
                <td className="strong">{order.reference ?? order.id}</td>
                <td>{order.customerName}</td>
                <td>{shortDate(order.orderDate)}</td>
                <td>
                  <StatusBadge status={order.status} />
                </td>
                <td>
                  {order.invoiceNumber ? (
                    <>
                      {order.invoiceNumber} <StatusBadge status={order.invoiceStatus} />
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">{order.items.length}</td>
                <td className="num">{money(financialValue(order.totalDecimal, order.total))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
