import {
  AnnualRevenueSchema,
  CustomerRevenueSchema,
  QuarterRevenueSchema,
  type AnnualRevenue,
  type CustomerRevenue,
  type QuarterRevenue,
  type RevenueReportRequest,
} from "@meridian/contracts";
import { prisma } from "../db";

export type ReportPeriod = RevenueReportRequest["query"];

export const REVENUE_RECOGNIZED_STATUSES = ["POSTED", "SENT", "PAID"] as const;

export interface ReportableInvoice {
  status: string;
  issueDate: Date;
  total: number;
  customerId: string;
  customer: { name: string };
}

export interface RevenueRow {
  issueDate: Date;
  customerId: string;
  customerName: string;
  revenue: number;
}

// Invoice.total is the materialized billing amount. In contrast to rebuilding a
// total from an order, it preserves invoice-level adjustments and does not rely
// on mutable rates or products that may no longer exist.
export function toRecognizedRevenueRows(invoices: readonly ReportableInvoice[]): RevenueRow[] {
  const recognizedStatuses = new Set<string>(REVENUE_RECOGNIZED_STATUSES);
  return invoices
    .filter((invoice) => recognizedStatuses.has(invoice.status))
    .map((invoice) => ({
      issueDate: invoice.issueDate,
      customerId: invoice.customerId,
      customerName: invoice.customer.name,
      revenue: invoice.total,
    }));
}

async function invoiceRevenues(period: ReportPeriod): Promise<RevenueRow[]> {
  const issueDate: { gte?: Date; lte?: Date } = {};
  if (period.from) issueDate.gte = new Date(period.from);
  if (period.to) issueDate.lte = new Date(period.to);
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: [...REVENUE_RECOGNIZED_STATUSES] },
      ...(period.from || period.to ? { issueDate } : {}),
    },
    select: {
      status: true,
      issueDate: true,
      total: true,
      customerId: true,
      customer: { select: { name: true } },
    },
  });
  return toRecognizedRevenueRows(invoices);
}

function periodBounds(
  period: ReportPeriod,
  dates: readonly Date[]
): { start: Date; end: Date } | null {
  const start = period.from
    ? new Date(period.from)
    : dates.length > 0
      ? new Date(Math.min(...dates.map((date) => date.getTime())))
      : null;
  const end = period.to
    ? new Date(period.to)
    : dates.length > 0
      ? new Date(Math.max(...dates.map((date) => date.getTime())))
      : null;
  if (!start || !end || start > end) return null;
  return { start, end };
}

export function summarizeRevenueByQuarter(
  rows: readonly RevenueRow[],
  period: ReportPeriod
): QuarterRevenue[] {
  const totals = new Map<string, { invoiceCount: number; revenue: number }>();
  for (const row of rows) {
    const quarter = Math.floor(row.issueDate.getMonth() / 3) + 1;
    const key = `${row.issueDate.getFullYear()}-Q${quarter}`;
    const bucket = totals.get(key) ?? { invoiceCount: 0, revenue: 0 };
    bucket.invoiceCount += 1;
    bucket.revenue += row.revenue;
    totals.set(key, bucket);
  }

  // Emit every quarter in the period, including empty ones.
  const bounds = periodBounds(
    period,
    rows.map((row) => row.issueDate)
  );
  if (!bounds) return [];
  const result: QuarterRevenue[] = [];
  let year = bounds.start.getFullYear();
  let quarter = Math.floor(bounds.start.getMonth() / 3) + 1;
  const endYear = bounds.end.getFullYear();
  const endQuarter = Math.floor(bounds.end.getMonth() / 3) + 1;
  while (year < endYear || (year === endYear && quarter <= endQuarter)) {
    const key = `${year}-Q${quarter}`;
    const bucket = totals.get(key);
    result.push({
      quarter: key,
      invoiceCount: bucket?.invoiceCount ?? 0,
      revenue: bucket?.revenue ?? 0,
    });
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
  }
  return QuarterRevenueSchema.array().parse(result);
}

export function summarizeRevenueByCustomer(rows: readonly RevenueRow[]): CustomerRevenue[] {
  const buckets = new Map<string, CustomerRevenue>();
  for (const row of rows) {
    const bucket = buckets.get(row.customerId) ?? {
      customerId: row.customerId,
      customerName: row.customerName,
      invoiceCount: 0,
      revenue: 0,
    };
    bucket.invoiceCount += 1;
    bucket.revenue += row.revenue;
    buckets.set(row.customerId, bucket);
  }
  return CustomerRevenueSchema.array().parse(
    [...buckets.values()].toSorted((a, b) => b.revenue - a.revenue)
  );
}

export function summarizeAnnualRevenue(
  rows: readonly RevenueRow[],
  period: ReportPeriod
): AnnualRevenue[] {
  const totals = new Map<number, { invoiceCount: number; revenue: number }>();
  for (const row of rows) {
    const year = row.issueDate.getFullYear();
    const bucket = totals.get(year) ?? { invoiceCount: 0, revenue: 0 };
    bucket.invoiceCount += 1;
    bucket.revenue += row.revenue;
    totals.set(year, bucket);
  }

  const bounds = periodBounds(
    period,
    rows.map((row) => row.issueDate)
  );
  if (!bounds) return [];
  const result: AnnualRevenue[] = [];
  for (let year = bounds.start.getFullYear(); year <= bounds.end.getFullYear(); year++) {
    const bucket = totals.get(year);
    result.push({
      year,
      invoiceCount: bucket?.invoiceCount ?? 0,
      revenue: bucket?.revenue ?? 0,
    });
  }
  return AnnualRevenueSchema.array().parse(result);
}

export async function revenueByQuarter(period: ReportPeriod): Promise<QuarterRevenue[]> {
  return summarizeRevenueByQuarter(await invoiceRevenues(period), period);
}

export async function revenueByCustomer(period: ReportPeriod): Promise<CustomerRevenue[]> {
  return summarizeRevenueByCustomer(await invoiceRevenues(period));
}

export async function annualRevenue(period: ReportPeriod): Promise<AnnualRevenue[]> {
  return summarizeAnnualRevenue(await invoiceRevenues(period), period);
}
