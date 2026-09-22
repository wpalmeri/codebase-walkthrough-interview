import { prisma } from "../db";

export interface ReportPeriod {
  from?: string;
  to?: string;
}

export interface QuarterRevenue {
  quarter: string;
  invoiceCount: number;
  revenue: number;
}

export interface CustomerRevenue {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  revenue: number;
}

export interface AnnualRevenue {
  year: number;
  invoiceCount: number;
  revenue: number;
}

// Revenue for an invoice is computed from its order's items at current prices.
async function invoiceRevenues(period: ReportPeriod) {
  const issueDate: { gte?: Date; lte?: Date } = {};
  if (period.from) issueDate.gte = new Date(period.from);
  if (period.to) issueDate.lte = new Date(period.to);
  const invoices = await prisma.invoice.findMany({
    where: period.from || period.to ? { issueDate } : undefined,
    include: {
      customer: true,
      order: { include: { items: true } },
    },
  });
  return invoices.map((invoice) => ({
    invoice,
    revenue: invoice.order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
  }));
}

function periodBounds(
  period: ReportPeriod,
  dates: Date[]
): { start: Date; end: Date } | null {
  const start = period.from
    ? new Date(period.from)
    : dates.length > 0
      ? new Date(Math.min(...dates.map((d) => d.getTime())))
      : null;
  const end = period.to
    ? new Date(period.to)
    : dates.length > 0
      ? new Date(Math.max(...dates.map((d) => d.getTime())))
      : null;
  if (!start || !end || start > end) return null;
  return { start, end };
}

export async function revenueByQuarter(period: ReportPeriod): Promise<QuarterRevenue[]> {
  const rows = await invoiceRevenues(period);
  const totals = new Map<string, { invoiceCount: number; revenue: number }>();
  for (const { invoice, revenue } of rows) {
    const q = Math.floor(invoice.issueDate.getMonth() / 3) + 1;
    const key = `${invoice.issueDate.getFullYear()}-Q${q}`;
    const bucket = totals.get(key) ?? { invoiceCount: 0, revenue: 0 };
    bucket.invoiceCount += 1;
    bucket.revenue += revenue;
    totals.set(key, bucket);
  }

  // Emit every quarter in the period, including empty ones.
  const bounds = periodBounds(period, rows.map((row) => row.invoice.issueDate));
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
  return result;
}

export async function revenueByCustomer(period: ReportPeriod): Promise<CustomerRevenue[]> {
  const rows = await invoiceRevenues(period);
  const buckets = new Map<string, CustomerRevenue>();
  for (const { invoice, revenue } of rows) {
    const bucket = buckets.get(invoice.customerId) ?? {
      customerId: invoice.customerId,
      customerName: invoice.customer.name,
      invoiceCount: 0,
      revenue: 0,
    };
    bucket.invoiceCount += 1;
    bucket.revenue += revenue;
    buckets.set(invoice.customerId, bucket);
  }
  return [...buckets.values()].toSorted((a, b) => b.revenue - a.revenue);
}

export async function annualRevenue(period: ReportPeriod): Promise<AnnualRevenue[]> {
  const rows = await invoiceRevenues(period);
  const totals = new Map<number, { invoiceCount: number; revenue: number }>();
  for (const { invoice, revenue } of rows) {
    const year = invoice.issueDate.getFullYear();
    const bucket = totals.get(year) ?? { invoiceCount: 0, revenue: 0 };
    bucket.invoiceCount += 1;
    bucket.revenue += revenue;
    totals.set(year, bucket);
  }

  const bounds = periodBounds(period, rows.map((row) => row.invoice.issueDate));
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
  return result;
}
