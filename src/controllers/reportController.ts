import {
  AnnualRevenueSchema,
  CustomerRevenueSchema,
  QuarterRevenueSchema,
  type AnnualRevenue,
  type CustomerRevenue,
  type InvoiceStatus,
  type QuarterRevenue,
  type RevenueReportRequest,
} from "@meridian/contracts";
import { Prisma } from "@prisma/client";
import { z } from "zod";
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
  legacyNumber,
  type DecimalInput,
} from "../domain/money";

export type ReportPeriod = RevenueReportRequest["query"];

export const REVENUE_RECOGNIZED_STATUSES = ["POSTED", "SENT", "PAID"] as const;
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "revenue" } as const;
const zeroMoney = decimalOrLegacy({ decimal: "0", legacy: null }, moneyFormat);

export interface ReportableInvoice {
  status: InvoiceStatus;
  issueDate: Date;
  accountingDate?: string | null;
  total: number;
  totalDecimal?: DecimalInput | null;
  customerId: string;
  customerNameSnapshot?: string | null;
  customer: { name: string };
}

export interface RevenueRow {
  accountingDate: AccountingDate;
  customerId: string;
  customerName: string;
  revenue: number;
  revenueDecimal: string;
}

export interface RevenueAggregateQueryClient {
  $queryRaw(query: Prisma.Sql): Promise<unknown[]>;
}

export interface RevenueAggregateRepository {
  page(tenantId: string, period: ReportPeriod, afterId: string | null): Promise<readonly RevenueInput[]>;
}

export interface RevenueInput {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly accountingDate: AccountingDate;
  readonly quarter: string;
  readonly year: number;
  readonly revenueDecimal: string;
}

const RevenueInputSqlRowSchema = z.strictObject({
  id: z.string().min(1),
  customerId: z.string().min(1),
  customerName: z.string(),
  accountingDate: z.string(),
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/u),
  year: z.coerce.number().int().min(1).max(9_999),
  revenueDecimal: z.string().min(1),
});
export const REVENUE_PAGE_SIZE = 250;

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
        // Finalized invoices own their historical customer identity. Live
        // customer data remains a compatibility fallback only for legacy rows
        // that have not completed the snapshot backfill.
        customerName: invoice.customerNameSnapshot ?? invoice.customer.name,
        revenue: legacyNumber(revenueDecimal, moneyFormat),
        revenueDecimal,
      };
    });
}

function reportFilter(tenantId: string, period: ReportPeriod): Prisma.Sql {
  const from = period.from === undefined ? undefined : reportAccountingDate(period.from);
  const to = period.to === undefined ? undefined : reportAccountingDate(period.to);
  const conditions = [
    Prisma.sql`"Invoice"."tenantId" = ${tenantId}`,
    Prisma.sql`"Invoice"."status" IN (${Prisma.join(REVENUE_RECOGNIZED_STATUSES)})`,
  ];
  if (from !== undefined || to !== undefined) {
    const accountingDateConditions = [
      ...(from === undefined ? [] : [Prisma.sql`"Invoice"."accountingDate" >= ${from}`]),
      ...(to === undefined ? [] : [Prisma.sql`"Invoice"."accountingDate" <= ${to}`]),
    ];
    const issueDateConditions = [
      ...(from === undefined ? [] : [Prisma.sql`"Invoice"."issueDate" >= ${new Date(`${from}T00:00:00.000Z`)}`]),
      ...(to === undefined ? [] : [Prisma.sql`"Invoice"."issueDate" <= ${new Date(`${to}T23:59:59.999Z`)}`]),
    ];
    conditions.push(Prisma.sql`(
      ("Invoice"."accountingDate" IS NOT NULL AND ${Prisma.join(accountingDateConditions, " AND ")})
      OR ("Invoice"."accountingDate" IS NULL AND ${Prisma.join(issueDateConditions, " AND ")})
    )`);
  }
  return Prisma.sql`FROM "Invoice"
    INNER JOIN "Customer" ON "Customer"."id" = "Invoice"."customerId"
    WHERE ${Prisma.join(conditions, " AND ")}`;
}

const effectiveAccountingDateSql = Prisma.sql`CASE
  -- Prisma's SQLite adapter may persist DateTime as Unix milliseconds. Legacy
  -- databases can also contain ISO text, so normalize both physical forms.
  WHEN "Invoice"."accountingDate" IS NULL AND typeof("Invoice"."issueDate") IN ('integer', 'real')
    THEN strftime('%Y-%m-%d', "Invoice"."issueDate" / 1000, 'unixepoch')
  WHEN "Invoice"."accountingDate" IS NULL THEN substr("Invoice"."issueDate", 1, 10)
  ELSE "Invoice"."accountingDate"
END`;

const prismaRevenueAggregateQueryClient: RevenueAggregateQueryClient = {
  $queryRaw(query) {
    return prisma.$queryRaw<unknown[]>(query);
  },
};

export function createRevenueAggregateRepository(
  queryClient: RevenueAggregateQueryClient = prismaRevenueAggregateQueryClient,
  pageSize = REVENUE_PAGE_SIZE
): RevenueAggregateRepository {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > REVENUE_PAGE_SIZE) {
    throw new Error(`pageSize must be a whole number from 1 through ${REVENUE_PAGE_SIZE}`);
  }
  return {
    async page(tenantId, period, afterId) {
      const rows = await queryClient.$queryRaw(Prisma.sql`
        SELECT
          "Invoice"."id" AS "id",
          "Invoice"."customerId" AS "customerId",
          COALESCE("Invoice"."customerNameSnapshot", "Customer"."name") AS "customerName",
          ${effectiveAccountingDateSql} AS "accountingDate",
          strftime('%Y', ${effectiveAccountingDateSql}) || '-Q' ||
            CAST(((CAST(strftime('%m', ${effectiveAccountingDateSql}) AS INTEGER) - 1) / 3) + 1 AS TEXT) AS "quarter",
          CAST(strftime('%Y', ${effectiveAccountingDateSql}) AS INTEGER) AS "year",
          CAST(COALESCE("Invoice"."totalDecimal", "Invoice"."total") AS TEXT) AS "revenueDecimal"
        ${reportFilter(tenantId, period)}
        ${afterId === null ? Prisma.empty : Prisma.sql`AND "Invoice"."id" > ${afterId}`}
        ORDER BY "Invoice"."id" ASC
        LIMIT ${pageSize}
      `);
      return rows.map((row) => {
        const parsed = RevenueInputSqlRowSchema.parse(row);
        return {
          id: parsed.id,
          customerId: parsed.customerId,
          customerName: parsed.customerName,
          accountingDate: reportAccountingDate(parsed.accountingDate),
          quarter: parsed.quarter,
          year: parsed.year,
          revenueDecimal: decimalOrLegacy(
            { decimal: parsed.revenueDecimal, legacy: null },
            moneyFormat
          ),
        };
      });
    },
  };
}

const revenueAggregateRepository = createRevenueAggregateRepository();

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
    year: Number.parseInt(accountingDate.slice(0, 4), 10),
    month: Number.parseInt(accountingDate.slice(5, 7), 10),
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
      revenue: legacyNumber(bucket.revenueDecimal, moneyFormat),
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
      revenue: legacyNumber(bucket.revenueDecimal, moneyFormat),
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
      revenue: legacyNumber(bucket.revenueDecimal, moneyFormat),
      revenueDecimal: bucket.revenueDecimal,
    });
  }
  return AnnualRevenueSchema.array().parse(result);
}

interface RevenueBucket {
  invoiceCount: number;
  revenueDecimal: string;
}

interface CustomerRevenueBucket extends RevenueBucket {
  customerId: string;
  customerName: string;
}

interface PagedRevenueTotals {
  readonly quarters: Map<string, RevenueBucket>;
  readonly customers: Map<string, CustomerRevenueBucket>;
  readonly years: Map<number, RevenueBucket>;
  firstAccountingDate: AccountingDate | null;
  lastAccountingDate: AccountingDate | null;
}

function addRevenue(bucket: RevenueBucket, input: RevenueInput): void {
  bucket.invoiceCount += 1;
  bucket.revenueDecimal = addDecimal(bucket.revenueDecimal, input.revenueDecimal, moneyFormat);
}

async function readPagedRevenueTotals(
  tenantId: string,
  period: ReportPeriod,
  repository: RevenueAggregateRepository
): Promise<PagedRevenueTotals> {
  const totals: PagedRevenueTotals = {
    quarters: new Map(),
    customers: new Map(),
    years: new Map(),
    firstAccountingDate: null,
    lastAccountingDate: null,
  };
  let afterId: string | null = null;
  for (;;) {
    const page = await repository.page(tenantId, period, afterId);
    if (page.length > REVENUE_PAGE_SIZE) {
      throw new Error(`revenue repository returned more than ${REVENUE_PAGE_SIZE} inputs in one page`);
    }
    if (page.length === 0) return totals;

    for (const input of page) {
      if (afterId !== null && input.id <= afterId) {
        throw new Error("revenue repository keyset order must advance by invoice id");
      }
      const quarterBucket = totals.quarters.get(input.quarter) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
      addRevenue(quarterBucket, input);
      totals.quarters.set(input.quarter, quarterBucket);

      const customerBucket = totals.customers.get(input.customerId) ?? {
        customerId: input.customerId,
        customerName: input.customerName,
        invoiceCount: 0,
        revenueDecimal: zeroMoney,
      };
      addRevenue(customerBucket, input);
      totals.customers.set(input.customerId, customerBucket);

      const yearBucket = totals.years.get(input.year) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
      addRevenue(yearBucket, input);
      totals.years.set(input.year, yearBucket);

      totals.firstAccountingDate =
        totals.firstAccountingDate === null || input.accountingDate < totals.firstAccountingDate
          ? input.accountingDate
          : totals.firstAccountingDate;
      totals.lastAccountingDate =
        totals.lastAccountingDate === null || input.accountingDate > totals.lastAccountingDate
          ? input.accountingDate
          : totals.lastAccountingDate;
      afterId = input.id;
    }
  }
}

function pagedBounds(
  period: ReportPeriod,
  totals: PagedRevenueTotals
): { start: AccountingDate; end: AccountingDate } | null {
  const dates = [totals.firstAccountingDate, totals.lastAccountingDate].filter(
    (date): date is AccountingDate => date !== null
  );
  return periodBounds(period, dates);
}

function summarizePagedQuarterRevenue(totals: PagedRevenueTotals, period: ReportPeriod): QuarterRevenue[] {
  const bounds = pagedBounds(period, totals);
  if (bounds === null) return [];
  const start = yearAndMonth(bounds.start);
  const end = yearAndMonth(bounds.end);
  const result: QuarterRevenue[] = [];
  let year = start.year;
  let quarter = Math.floor((start.month - 1) / 3) + 1;
  const endQuarter = Math.floor((end.month - 1) / 3) + 1;
  while (year < end.year || (year === end.year && quarter <= endQuarter)) {
    const key = `${year}-Q${quarter}`;
    const bucket = totals.quarters.get(key) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
    result.push({
      quarter: key,
      invoiceCount: bucket.invoiceCount,
      revenue: legacyNumber(bucket.revenueDecimal, moneyFormat),
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

function summarizePagedCustomerRevenue(totals: PagedRevenueTotals): CustomerRevenue[] {
  const result = [...totals.customers.values()]
    .map((bucket) => {
      const { customerId, customerName, invoiceCount, revenueDecimal } = bucket;
      return {
        customerId,
        customerName,
        invoiceCount,
        revenue: legacyNumber(revenueDecimal, moneyFormat),
        revenueDecimal,
      };
    })
    .toSorted((left, right) => compareDecimal(right.revenueDecimal, left.revenueDecimal, moneyFormat));
  return CustomerRevenueSchema.array().parse(result);
}

function summarizePagedAnnualRevenue(totals: PagedRevenueTotals, period: ReportPeriod): AnnualRevenue[] {
  const bounds = pagedBounds(period, totals);
  if (bounds === null) return [];
  const startYear = yearAndMonth(bounds.start).year;
  const endYear = yearAndMonth(bounds.end).year;
  const result: AnnualRevenue[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    const bucket = totals.years.get(year) ?? { invoiceCount: 0, revenueDecimal: zeroMoney };
    result.push({
      year,
      invoiceCount: bucket.invoiceCount,
      revenue: legacyNumber(bucket.revenueDecimal, moneyFormat),
      revenueDecimal: bucket.revenueDecimal,
    });
  }
  return AnnualRevenueSchema.array().parse(result);
}

export async function revenueByQuarter(
  tenantId: string,
  period: ReportPeriod,
  repository: RevenueAggregateRepository = revenueAggregateRepository
): Promise<QuarterRevenue[]> {
  return summarizePagedQuarterRevenue(await readPagedRevenueTotals(tenantId, period, repository), period);
}

export async function revenueByCustomer(
  tenantId: string,
  period: ReportPeriod,
  repository: RevenueAggregateRepository = revenueAggregateRepository
): Promise<CustomerRevenue[]> {
  return summarizePagedCustomerRevenue(await readPagedRevenueTotals(tenantId, period, repository));
}

export async function annualRevenue(
  tenantId: string,
  period: ReportPeriod,
  repository: RevenueAggregateRepository = revenueAggregateRepository
): Promise<AnnualRevenue[]> {
  return summarizePagedAnnualRevenue(await readPagedRevenueTotals(tenantId, period, repository), period);
}
