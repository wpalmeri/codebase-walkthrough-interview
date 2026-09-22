import { useCallback, useEffect, useState } from "react";
import {
  apiGet,
  compactMoney,
  decimalNumber,
  errorMessage,
  financialValue,
  money,
  sumMoney,
} from "../api";
import { Card, EmptyState, PageHeader, StatTile } from "../components";
import type { AnnualRevenue, CustomerRevenue, QuarterRevenue } from "../types";

function QuarterChart({ data }: { data: QuarterRevenue[] }) {
  if (data.length === 0) return null;
  const width = 640;
  const height = 200;
  const pad = { top: 24, bottom: 26, left: 8, right: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = data.map((row) => financialValue(row.revenueDecimal, row.revenue));
  const numericValues = values.map(decimalNumber);
  const max = Math.max(1, ...numericValues) * 1.08;
  const slot = innerW / data.length;
  const barW = Math.max(4, Math.min(44, slot * 0.55));
  // On long ranges, thin out labels so they stay legible.
  const showValues = data.length <= 10;
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label="Revenue by quarter"
    >
      {data.map((d, i) => {
        const revenue = values[i] ?? 0;
        const numericRevenue = numericValues[i] ?? 0;
        const barH = Math.max(numericRevenue > 0 ? 2 : 1, (numericRevenue / max) * innerH);
        const x = pad.left + slot * i + (slot - barW) / 2;
        const y = pad.top + innerH - barH;
        return (
          <g key={d.quarter}>
            <title>{`${d.quarter}: ${money(revenue)} (${d.invoiceCount} invoices)`}</title>
            <rect
              x={x}
              y={y}
              width={barW}
              height={barH}
              rx={Math.min(4, barW / 2)}
              fill={numericRevenue > 0 ? "#4f46e5" : "#e6e9ef"}
            />
            {showValues && numericRevenue > 0 && (
              <text x={x + barW / 2} y={y - 7} textAnchor="middle" fontSize="11" fill="#475467">
                {compactMoney(revenue)}
              </text>
            )}
            {i % labelEvery === 0 && (
              <text
                x={x + barW / 2}
                y={pad.top + innerH + 16}
                textAnchor="middle"
                fontSize="11"
                fill="#98a2b3"
              >
                {d.quarter}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1={pad.left}
        x2={width - pad.right}
        y1={pad.top + innerH}
        y2={pad.top + innerH}
        stroke="#e6e9ef"
      />
    </svg>
  );
}

export function ReportsPage() {
  const [quarters, setQuarters] = useState<QuarterRevenue[]>([]);
  const [byCustomer, setByCustomer] = useState<CustomerRevenue[]>([]);
  const [annual, setAnnual] = useState<AnnualRevenue[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((fromDate: string, toDate: string) => {
    setError(null);
    const params = new URLSearchParams();
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    const qs = params.toString() ? `?${params.toString()}` : "";
    apiGet<QuarterRevenue[]>(`/reports/revenue-by-quarter${qs}`)
      .then(setQuarters)
      .catch((error) => setError(errorMessage(error)));
    apiGet<CustomerRevenue[]>(`/reports/revenue-by-customer${qs}`)
      .then(setByCustomer)
      .catch((error) => setError(errorMessage(error)));
    apiGet<AnnualRevenue[]>(`/reports/annual-revenue${qs}`)
      .then(setAnnual)
      .catch((error) => setError(errorMessage(error)));
  }, []);
  useEffect(() => load("", ""), [load]);

  const totalRevenue = sumMoney(
    annual.map((row) => financialValue(row.revenueDecimal, row.revenue))
  );
  const totalInvoices = annual.reduce((sum, row) => sum + row.invoiceCount, 0);
  const topCustomer = byCustomer[0];

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Standard revenue reporting across invoices."
        actions={
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="muted">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <button className="btn" onClick={() => load(from, to)}>
              Run
            </button>
            {(from || to) && (
              <button
                className="btn"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  load("", "");
                }}
              >
                All time
              </button>
            )}
          </>
        }
      />
      <div className="stat-row">
        <StatTile
          label="Revenue in period"
          value={money(totalRevenue)}
          hint={`${totalInvoices} invoices`}
        />
        <StatTile
          label="Top customer"
          value={topCustomer ? topCustomer.customerName : "—"}
          hint={
            topCustomer
              ? money(financialValue(topCustomer.revenueDecimal, topCustomer.revenue))
              : undefined
          }
        />
        <StatTile
          label="Quarters covered"
          value={String(quarters.length)}
        />
      </div>

      {error && <div className="banner error">{error}</div>}

      <Card title="Revenue by quarter">
        {quarters.length === 0 ? (
          <EmptyState>No invoices in this period.</EmptyState>
        ) : (
          <div className="chart-wrap">
            <QuarterChart data={quarters} />
          </div>
        )}
      </Card>

      <div className="detail-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Card title="Revenue by customer" flush>
          {byCustomer.length === 0 ? (
            <EmptyState>No invoices in this period.</EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Invoices</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {byCustomer.map((row) => (
                  <tr key={row.customerId}>
                    <td className="strong">{row.customerName}</td>
                    <td className="num">{row.invoiceCount}</td>
                    <td className="num">{money(financialValue(row.revenueDecimal, row.revenue))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Annual revenue" flush>
          {annual.length === 0 ? (
            <EmptyState>No invoices in this period.</EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="num">Invoices</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {annual.map((row) => (
                  <tr key={row.year}>
                    <td className="strong">{row.year}</td>
                    <td className="num">{row.invoiceCount}</td>
                    <td className="num">{money(financialValue(row.revenueDecimal, row.revenue))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
