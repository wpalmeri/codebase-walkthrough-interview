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
import {
  parseAccountingDate,
  utcAccountingDateFromInstant,
  type AccountingDate,
} from "../domain/accountingPeriod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  addDecimal,
  compareDecimal,
  decimalOrLegacy,
  type DecimalInput,
} from "../domain/money";

export type ReportPeriod = RevenueReportRequest["query"];

export const REVENUE_RECOGNIZED_STATUSES = ["POSTED", "SENT", "PAID"] as const;
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "revenue" } as const;
const zeroMoney = decimalOrLegacy({ decimal: "0", legacy: null }, moneyFormat);

export interface ReportableInvoice {
  status: string;
  issueDate: Date;
  accountingDate?: string | null;
  total: number;
  totalDecimal?: DecimalInput | null;
  customerId: string;
  customer: { name: string };
}

export interface RevenueRow {
  accountingDate: AccountingDate;
  customerId: string;
  customerName: string;
  revenue: number;
  revenueDecimal: string;
}

function reportAccountingDate(value: string): AccountingDate {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? parseAccountingDate(value)
    : utcAccountingDateFromInstant(new Date(value));
}

// Invoice totals and accounting dates are materialized. Legacy timestamp/float
// fallback remains only for rows not yet processed by the bounded backfill.
export function toRecognizedRevenueRows(invoices: readonly ReportableInvoice[]): RevenueRow[] {
  const recognizedStatuses = new Set<string>(REVENUE_RECOGNIZED_STATUSES);
  return invoices
    .filter((invoice) => recognizedStatuses.has(invoice.status))
    .map((invoice) => {
      const revenueDecimal = decimalOrLegacy(
        { decimal: invoice.totalDecimal, legacy: invoice.total },
        { ...moneyFormat, field: "invoice revenue" }
      );
      return {
        accountingDate:
          invoice.accountingDate === null || invoice.accountingDate === undefined
            ? utcAccountingDateFromInstant(invoice.issueDate)
            : parseAccountingDate(invoice.accountingDate),
        customerId: invoice.customerId,
        customerName: invoice.customer.name,
        revenue: Number(revenueDecimal),
        revenueDecimal,
      };
    });
}

async function invoiceRevenues(period: ReportPeriod): Promise<RevenueRow[]> {
  const from = period.from === undefined ? undefined : reportAccountingDate(period.from);
  const to = period.to === undefined ? undefined : reportAccountingDate(period.to);
  const accountingDate = {
    ...(from === undefined ? {} : { gte: from }),
    ...(to === undefined ? {} : { lte: to }),
  };
  const issueDate = {
    ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
    ...(to === undefined ? {} : { lte: new Date(`${to}T23:59:59.999Z`) }),
  };
  const hasPeriod = from !== undefined || to !== undefined;
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: [...REVENUE_RECOGNIZED_STATUSES] },
      ...(hasPeriod
        ? {
            OR: [
              { accountingDate },
              { accountingDate: null, issueDate },
            ],
          }
        : {}),
    },
    select: {
      status: true,
      issueDate: true,
      accountingDate: true,
      total: true,
      totalDecimal: true,
      customerId: true,
      customer: { select: { name: true } },
    },
  });
  return toRecognizedRevenueRows(invoices);
}

function periodBounds(
  period: ReportPeriod,
  dates: readonly AccountingDate[]
): { start: AccountingDate; end: AccountingDate } | null {
  const start =
    period.from === undefined
      ? dates.toSorted()[0]
      : reportAccountingDate(period.from);
  const end =
    period.to === undefined
      ? dates.toSorted().at(-1)
      : reportAccountingDate(period.to);
  if (start === undefined || end === undefined || start > end) return null;
  return { start, end };
}

function yearAndMonth(accountingDate: AccountingDate): { year: number; month: number } {
  return {
    year: Number(accountingDate.slice(0, 4)),
    month: Number(accountingDate.slice(5, 7)),
  };
}

export function summarizeRevenueByQuarter(
  rows: readonly RevenueRow[],
  period: ReportPeriod
): QuarterRevenue[] {
  const totals = new Map<string, { invoiceCount: number; revenueDecimal: string }>();
  for (const row of rows) {
    const { year, month } = yearAndMonth(row.accountingDate);
    const quarter = Math.floor((month - 1) / 3) + 1;
    const key = `${year}-Q${quarter}`;
    const bucket = totals.get(key) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
    bucket.invoiceCount += 1;
    bucket.revenueDecimal = addDecimal(bucket.revenueDecimal, row.revenueDecimal, moneyFormat);
    totals.set(key, bucket);
  }

  const bounds = periodBounds(
    period,
    rows.map((row) => row.accountingDate)
  );
  if (!bounds) return [];
  const start = yearAndMonth(bounds.start);
  const end = yearAndMonth(bounds.end);
  const result: QuarterRevenue[] = [];
  let year = start.year;
  let quarter = Math.floor((start.month - 1) / 3) + 1;
  const endQuarter = Math.floor((end.month - 1) / 3) + 1;
  while (year < end.year || (year === end.year && quarter <= endQuarter)) {
    const key = `${year}-Q${quarter}`;
    const bucket = totals.get(key) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
    result.push({
      quarter: key,
      invoiceCount: bucket.invoiceCount,
      revenue: Number(bucket.revenueDecimal),
      revenueDecimal: bucket.revenueDecimal,
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
  const buckets = new Map<
    string,
    { customerId: string; customerName: string; invoiceCount: number; revenueDecimal: string }
  >();
  for (const row of rows) {
    const bucket = buckets.get(row.customerId) ?? {
      customerId: row.customerId,
      customerName: row.customerName,
      invoiceCount: 0,
      revenueDecimal: zeroMoney,
    };
    bucket.invoiceCount += 1;
    bucket.revenueDecimal = addDecimal(bucket.revenueDecimal, row.revenueDecimal, moneyFormat);
    buckets.set(row.customerId, bucket);
  }
  const result = [...buckets.values()]
    .toSorted((left, right) => compareDecimal(right.revenueDecimal, left.revenueDecimal, moneyFormat))
    .map((bucket) => ({
      ...bucket,
      revenue: Number(bucket.revenueDecimal),
    }));
  return CustomerRevenueSchema.array().parse(result);
}

export function summarizeAnnualRevenue(
  rows: readonly RevenueRow[],
  period: ReportPeriod
): AnnualRevenue[] {
  const totals = new Map<number, { invoiceCount: number; revenueDecimal: string }>();
  for (const row of rows) {
    const year = yearAndMonth(row.accountingDate).year;
    const bucket = totals.get(year) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
    bucket.invoiceCount += 1;
    bucket.revenueDecimal = addDecimal(bucket.revenueDecimal, row.revenueDecimal, moneyFormat);
    totals.set(year, bucket);
  }

  const bounds = periodBounds(
    period,
    rows.map((row) => row.accountingDate)
  );
  if (!bounds) return [];
  const startYear = yearAndMonth(bounds.start).year;
  const endYear = yearAndMonth(bounds.end).year;
  const result: AnnualRevenue[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    const bucket = totals.get(year) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
    result.push({
      year,
      invoiceCount: bucket.invoiceCount,
      revenue: Number(bucket.revenueDecimal),
      revenueDecimal: bucket.revenueDecimal,
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
