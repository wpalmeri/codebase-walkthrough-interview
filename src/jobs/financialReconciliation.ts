import { CurrencyCodeSchema } from "@meridian/contracts";
import { z } from "zod";
import { prisma } from "../db";
import { parseAccountingDate } from "../domain/accountingPeriod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  addDecimal,
  canonicalMoney,
  canonicalQuantity,
  compareDecimal,
  type DecimalInput,
} from "../domain/money";
import { OrderPricingSnapshotSchema, repriceOrderPricingSnapshot } from "../domain/orderPricing";

const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "reconciliation amount" } as const;
const zeroMoney = canonicalMoney("0");
const entityTypes = ["PRODUCT", "RATE", "ORDER", "INVOICE", "PAYMENT"] as const;
const issueCodes = [
  "APPLICATIONS_EXCEED_INVOICE",
  "APPLICATIONS_EXCEED_PAYMENT",
  "CROSS_CURRENCY_APPLICATION",
  "CROSS_CUSTOMER_APPLICATION",
  "INVALID_ACCOUNTING_DATE",
  "INVALID_CURRENCY",
  "INVALID_EXACT_VALUE",
  "INVALID_INVOICE_LIFECYCLE",
  "INVALID_ORDER_LIFECYCLE",
  "INVALID_ORDER_SNAPSHOT",
  "INVOICE_AMOUNT_PAID_MISMATCH",
  "INVOICE_LIFECYCLE_CONTRADICTION",
  "INVOICE_LINE_TOTAL_MISMATCH",
  "MISSING_ACCOUNTING_DATE",
  "MISSING_CURRENCY",
  "MISSING_EXACT_VALUE",
  "MISSING_INVOICE_SNAPSHOT",
  "MISSING_ORDER_ITEMS",
  "MISSING_ORDER_SNAPSHOT",
  "ORDER_LINE_ARITHMETIC_INVALID",
  "ORDER_LINE_ARITHMETIC_MISMATCH",
  "ORDER_SNAPSHOT_CURRENCY_MISMATCH",
  "ORDER_SNAPSHOT_PROVENANCE_MISMATCH",
  "RATE_PRODUCT_CURRENCY_MISMATCH",
  "UNBOUNDED_PAGE",
  "UNSTABLE_PAGINATION",
] as const;

export const FinancialReconciliationIssueCodeSchema = z.enum(issueCodes);
export type FinancialReconciliationIssueCode = z.infer<typeof FinancialReconciliationIssueCodeSchema>;

export const FinancialReconciliationIssueSchema = z.strictObject({
  code: FinancialReconciliationIssueCodeSchema,
  entityType: z.enum(entityTypes),
  entityId: z.string().min(1),
  detail: z.string().min(1),
});
export type FinancialReconciliationIssue = z.infer<typeof FinancialReconciliationIssueSchema>;

export const FinancialReconciliationCursorsSchema = z.strictObject({
  products: z.string().nullable(),
  rates: z.string().nullable(),
  orders: z.string().nullable(),
  invoices: z.string().nullable(),
  payments: z.string().nullable(),
});

export const FinancialReconciliationResultSchema = z.strictObject({
  state: z.enum(["CLEAN", "VIOLATIONS", "INCOMPLETE"]),
  complete: z.boolean(),
  scanned: z.strictObject({
    products: z.number().int().nonnegative(),
    rates: z.number().int().nonnegative(),
    orders: z.number().int().nonnegative(),
    invoices: z.number().int().nonnegative(),
    payments: z.number().int().nonnegative(),
  }),
  cursors: FinancialReconciliationCursorsSchema,
  issues: z.array(FinancialReconciliationIssueSchema),
});
export type FinancialReconciliationResult = z.infer<typeof FinancialReconciliationResultSchema>;

export const FinancialReconciliationOptionsSchema = z.strictObject({
  batchSize: z.number().int().min(1).max(1_000).default(100),
  maxBatchesPerEntity: z.number().int().min(1).max(10_000).default(1_000),
});
export type FinancialReconciliationOptions = z.input<typeof FinancialReconciliationOptionsSchema>;

export interface ProductReconciliationSource {
  readonly id: string;
  readonly listPriceDecimal: DecimalInput | null;
  readonly currencyCode: string | null;
}

export interface RateReconciliationSource {
  readonly id: string;
  readonly unitPriceDecimal: DecimalInput | null;
  readonly currencyCode: string | null;
  readonly productCurrencyCode: string | null;
}

export interface OrderReconciliationSource {
  readonly id: string;
  readonly customerId: string;
  readonly currencyCode: string | null;
  readonly status: string;
  readonly items: readonly {
    readonly id: string;
    readonly productId: string;
    readonly rateId: string;
    readonly productSkuSnapshot: string | null;
    readonly productNameSnapshot: string | null;
    readonly productUnitSnapshot: string | null;
    readonly quantityDecimal: DecimalInput | null;
    readonly baseUnitPriceDecimal: DecimalInput | null;
    readonly effectiveUnitPriceDecimal: DecimalInput | null;
    readonly amountDecimal: DecimalInput | null;
    readonly pricingSnapshot: unknown;
    readonly pricingCapturedAt: Date | null;
    readonly snapshotVersion: number | null;
  }[];
}

export interface InvoiceReconciliationSource {
  readonly id: string;
  readonly customerId: string;
  readonly currencyCode: string | null;
  readonly status: string;
  readonly postedAt: Date | null;
  readonly accountingDate: string | null;
  readonly totalDecimal: DecimalInput | null;
  readonly amountPaidDecimal: DecimalInput | null;
  readonly customerNameSnapshot: string | null;
  readonly customerEmailSnapshot: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly productSkuSnapshot: string | null;
    readonly productUnitSnapshot: string | null;
    readonly quantityDecimal: DecimalInput | null;
    readonly unitPriceDecimal: DecimalInput | null;
    readonly amountDecimal: DecimalInput | null;
  }[];
  readonly applications: readonly {
    readonly id: string;
    readonly amountDecimal: DecimalInput | null;
    readonly payment: { readonly id: string; readonly customerId: string; readonly currencyCode: string | null };
  }[];
}

export interface PaymentReconciliationSource {
  readonly id: string;
  readonly customerId: string;
  readonly currencyCode: string | null;
  readonly amountDecimal: DecimalInput | null;
  readonly applications: readonly {
    readonly id: string;
    readonly amountDecimal: DecimalInput | null;
    readonly invoice: { readonly id: string; readonly customerId: string; readonly currencyCode: string | null };
  }[];
}

export interface FinancialReconciliationRepository {
  fetchProducts(afterId: string | null, limit: number): Promise<readonly ProductReconciliationSource[]>;
  fetchRates(afterId: string | null, limit: number): Promise<readonly RateReconciliationSource[]>;
  fetchOrders(afterId: string | null, limit: number): Promise<readonly OrderReconciliationSource[]>;
  fetchInvoices(afterId: string | null, limit: number): Promise<readonly InvoiceReconciliationSource[]>;
  fetchPayments(afterId: string | null, limit: number): Promise<readonly PaymentReconciliationSource[]>;
}

interface MutableRun {
  complete: boolean;
  readonly issues: FinancialReconciliationIssue[];
  readonly scanned: Record<"products" | "rates" | "orders" | "invoices" | "payments", number>;
  readonly cursors: Record<"products" | "rates" | "orders" | "invoices" | "payments", string | null>;
}

type EntityKey = keyof MutableRun["scanned"];
type EntityType = z.infer<typeof FinancialReconciliationIssueSchema>["entityType"];

function issue(
  run: MutableRun,
  entityType: EntityType,
  entityId: string,
  code: FinancialReconciliationIssueCode,
  detail: string
): void {
  run.issues.push(FinancialReconciliationIssueSchema.parse({ code, entityType, entityId, detail }));
}

function exactMoney(
  run: MutableRun,
  entityType: EntityType,
  entityId: string,
  field: string,
  value: DecimalInput | null
): string | null {
  if (value === null) {
    issue(run, entityType, entityId, "MISSING_EXACT_VALUE", `${field} is missing`);
    return null;
  }
  try {
    return canonicalMoney(value, field);
  } catch (error) {
    issue(run, entityType, entityId, "INVALID_EXACT_VALUE", error instanceof Error ? error.message : `${field} is invalid`);
    return null;
  }
}

function exactQuantity(
  run: MutableRun,
  entityType: EntityType,
  entityId: string,
  field: string,
  value: DecimalInput | null
): string | null {
  if (value === null) {
    issue(run, entityType, entityId, "MISSING_EXACT_VALUE", `${field} is missing`);
    return null;
  }
  try {
    return canonicalQuantity(value, field);
  } catch (error) {
    issue(run, entityType, entityId, "INVALID_EXACT_VALUE", error instanceof Error ? error.message : `${field} is invalid`);
    return null;
  }
}

function requiredCurrency(run: MutableRun, entityType: EntityType, entityId: string, field: string, value: string | null): string | null {
  if (value === null) {
    issue(run, entityType, entityId, "MISSING_CURRENCY", `${field} is missing`);
    return null;
  }
  if (!CurrencyCodeSchema.safeParse(value).success) {
    issue(run, entityType, entityId, "INVALID_CURRENCY", `${field} is not a supported currency`);
    return null;
  }
  return value;
}

function checkProducts(run: MutableRun, product: ProductReconciliationSource): void {
  exactMoney(run, "PRODUCT", product.id, `product ${product.id} list price`, product.listPriceDecimal);
  requiredCurrency(run, "PRODUCT", product.id, `product ${product.id} currency`, product.currencyCode);
}

function checkRates(run: MutableRun, rate: RateReconciliationSource): void {
  exactMoney(run, "RATE", rate.id, `rate ${rate.id} unit price`, rate.unitPriceDecimal);
  const currency = requiredCurrency(run, "RATE", rate.id, `rate ${rate.id} currency`, rate.currencyCode);
  if (currency !== null && rate.productCurrencyCode !== null && currency !== rate.productCurrencyCode) {
    issue(run, "RATE", rate.id, "RATE_PRODUCT_CURRENCY_MISMATCH", `rate ${rate.id} currency differs from its product`);
  }
}

function missingSnapshot(run: MutableRun, order: OrderReconciliationSource, itemId: string, field: string, value: unknown): void {
  if (value === null || value === undefined || value === "") {
    issue(run, "ORDER", order.id, "MISSING_ORDER_SNAPSHOT", `order item ${itemId} ${field} is missing`);
  }
}

function checkOrders(run: MutableRun, order: OrderReconciliationSource): void {
  const currency = requiredCurrency(run, "ORDER", order.id, `order ${order.id} currency`, order.currencyCode);
  if (!["OPEN", "INVOICED", "CLOSED"].includes(order.status)) {
    issue(run, "ORDER", order.id, "INVALID_ORDER_LIFECYCLE", `order ${order.id} has unknown status ${order.status}`);
  }
  if (order.items.length === 0) {
    issue(run, "ORDER", order.id, "MISSING_ORDER_ITEMS", `order ${order.id} has no captured items`);
  }
  for (const item of order.items.toSorted((left, right) => left.id.localeCompare(right.id))) {
    for (const [field, value] of [
      ["product SKU", item.productSkuSnapshot],
      ["product name", item.productNameSnapshot],
      ["product unit", item.productUnitSnapshot],
      ["pricing snapshot", item.pricingSnapshot],
      ["pricing capture time", item.pricingCapturedAt],
      ["snapshot version", item.snapshotVersion],
    ] as const) {
      missingSnapshot(run, order, item.id, field, value);
    }
    const quantity = exactQuantity(run, "ORDER", order.id, `order item ${item.id} quantity`, item.quantityDecimal);
    const baseUnitPrice = exactMoney(run, "ORDER", order.id, `order item ${item.id} base unit price`, item.baseUnitPriceDecimal);
    const effectiveUnitPrice = exactMoney(run, "ORDER", order.id, `order item ${item.id} effective unit price`, item.effectiveUnitPriceDecimal);
    const amount = exactMoney(run, "ORDER", order.id, `order item ${item.id} amount`, item.amountDecimal);
    if (quantity === null || baseUnitPrice === null || effectiveUnitPrice === null || amount === null || item.pricingSnapshot === null) continue;
    const snapshot = OrderPricingSnapshotSchema.safeParse(item.pricingSnapshot);
    if (!snapshot.success) {
      issue(run, "ORDER", order.id, "INVALID_ORDER_SNAPSHOT", `order item ${item.id} pricing snapshot is invalid`);
      continue;
    }
    try {
      const repriced = repriceOrderPricingSnapshot(snapshot.data, quantity);
      if (repriced.productId !== item.productId || repriced.rateId !== item.rateId) {
        issue(run, "ORDER", order.id, "ORDER_SNAPSHOT_PROVENANCE_MISMATCH", `order item ${item.id} snapshot does not match its provenance`);
      }
      if (currency !== null && snapshot.data.currencyCode !== currency) {
        issue(run, "ORDER", order.id, "ORDER_SNAPSHOT_CURRENCY_MISMATCH", `order item ${item.id} snapshot currency differs from order currency`);
      }
      if (
        repriced.amountDecimal !== amount ||
        repriced.baseUnitPriceDecimal !== baseUnitPrice ||
        repriced.effectiveUnitPriceDecimal !== effectiveUnitPrice
      ) {
        issue(run, "ORDER", order.id, "ORDER_LINE_ARITHMETIC_MISMATCH", `order item ${item.id} exact values do not reproduce from its snapshot`);
      }
    } catch (error) {
      issue(run, "ORDER", order.id, "ORDER_LINE_ARITHMETIC_INVALID", error instanceof Error ? error.message : `order item ${item.id} cannot be repriced`);
    }
  }
}

function checkInvoices(run: MutableRun, invoice: InvoiceReconciliationSource): void {
  const total = exactMoney(run, "INVOICE", invoice.id, `invoice ${invoice.id} total`, invoice.totalDecimal);
  const paid = exactMoney(run, "INVOICE", invoice.id, `invoice ${invoice.id} amount paid`, invoice.amountPaidDecimal);
  requiredCurrency(run, "INVOICE", invoice.id, `invoice ${invoice.id} currency`, invoice.currencyCode);
  if (invoice.customerNameSnapshot === null || invoice.customerEmailSnapshot === null) {
    issue(run, "INVOICE", invoice.id, "MISSING_INVOICE_SNAPSHOT", `invoice ${invoice.id} customer snapshot is incomplete`);
  }
  if (invoice.accountingDate === null) {
    issue(run, "INVOICE", invoice.id, "MISSING_ACCOUNTING_DATE", `invoice ${invoice.id} accounting date is missing`);
  } else {
    try {
      parseAccountingDate(invoice.accountingDate);
    } catch (error) {
      issue(run, "INVOICE", invoice.id, "INVALID_ACCOUNTING_DATE", error instanceof Error ? error.message : `invoice ${invoice.id} accounting date is invalid`);
    }
  }
  // The database permits DRAFT -> VOID without posting, so a voided draft is
  // not itself contradictory. Posted, sent, and paid invoices do require the
  // posting timestamp that records the transition out of draft.
  const postedLifecycle = ["POSTED", "SENT", "PAID"].includes(invoice.status);
  if (!["DRAFT", "POSTED", "SENT", "PAID", "VOID"].includes(invoice.status)) {
    issue(run, "INVOICE", invoice.id, "INVALID_INVOICE_LIFECYCLE", `invoice ${invoice.id} has unknown status ${invoice.status}`);
  }
  if (postedLifecycle && invoice.postedAt === null) {
    issue(run, "INVOICE", invoice.id, "INVOICE_LIFECYCLE_CONTRADICTION", `finalized invoice ${invoice.id} has no postedAt timestamp`);
  }
  if (invoice.status === "DRAFT" && invoice.postedAt !== null) {
    issue(run, "INVOICE", invoice.id, "INVOICE_LIFECYCLE_CONTRADICTION", `draft invoice ${invoice.id} has a postedAt timestamp`);
  }

  let lineTotal = zeroMoney;
  let lineValuesComplete = true;
  for (const line of invoice.lines.toSorted((left, right) => left.id.localeCompare(right.id))) {
    if (line.productSkuSnapshot === null || line.productUnitSnapshot === null) {
      issue(run, "INVOICE", invoice.id, "MISSING_INVOICE_SNAPSHOT", `invoice line ${line.id} product snapshot is incomplete`);
    }
    exactQuantity(run, "INVOICE", invoice.id, `invoice line ${line.id} quantity`, line.quantityDecimal);
    exactMoney(run, "INVOICE", invoice.id, `invoice line ${line.id} unit price`, line.unitPriceDecimal);
    const lineAmount = exactMoney(run, "INVOICE", invoice.id, `invoice line ${line.id} amount`, line.amountDecimal);
    if (lineAmount === null) lineValuesComplete = false;
    else lineTotal = addDecimal(lineTotal, lineAmount, moneyFormat);
  }
  if (lineValuesComplete && total !== null && compareDecimal(lineTotal, total, moneyFormat) !== 0) {
    issue(run, "INVOICE", invoice.id, "INVOICE_LINE_TOTAL_MISMATCH", `invoice ${invoice.id} line total ${lineTotal} differs from total ${total}`);
  }

  let applicationTotal = zeroMoney;
  let applicationValuesComplete = true;
  for (const application of invoice.applications.toSorted((left, right) => left.id.localeCompare(right.id))) {
    const applicationAmount = exactMoney(run, "INVOICE", invoice.id, `application ${application.id} amount`, application.amountDecimal);
    if (applicationAmount === null) applicationValuesComplete = false;
    else applicationTotal = addDecimal(applicationTotal, applicationAmount, moneyFormat);
    if (application.payment.customerId !== invoice.customerId) {
      issue(run, "INVOICE", invoice.id, "CROSS_CUSTOMER_APPLICATION", `application ${application.id} payment customer differs from invoice`);
    }
    if (application.payment.currencyCode !== null && invoice.currencyCode !== null && application.payment.currencyCode !== invoice.currencyCode) {
      issue(run, "INVOICE", invoice.id, "CROSS_CURRENCY_APPLICATION", `application ${application.id} payment currency differs from invoice`);
    }
  }
  if (applicationValuesComplete && paid !== null && compareDecimal(applicationTotal, paid, moneyFormat) !== 0) {
    issue(run, "INVOICE", invoice.id, "INVOICE_AMOUNT_PAID_MISMATCH", `invoice ${invoice.id} applications ${applicationTotal} differ from amount paid ${paid}`);
  }
  if (applicationValuesComplete && total !== null && compareDecimal(applicationTotal, total, moneyFormat) > 0) {
    issue(run, "INVOICE", invoice.id, "APPLICATIONS_EXCEED_INVOICE", `invoice ${invoice.id} applications exceed total`);
  }
  if (invoice.status === "PAID" && total !== null && paid !== null && compareDecimal(paid, total, moneyFormat) !== 0) {
    issue(run, "INVOICE", invoice.id, "INVOICE_LIFECYCLE_CONTRADICTION", `paid invoice ${invoice.id} does not have a zero balance`);
  }
}

function checkPayments(run: MutableRun, payment: PaymentReconciliationSource): void {
  const amount = exactMoney(run, "PAYMENT", payment.id, `payment ${payment.id} amount`, payment.amountDecimal);
  requiredCurrency(run, "PAYMENT", payment.id, `payment ${payment.id} currency`, payment.currencyCode);
  let applicationTotal = zeroMoney;
  let applicationValuesComplete = true;
  for (const application of payment.applications.toSorted((left, right) => left.id.localeCompare(right.id))) {
    const applicationAmount = exactMoney(run, "PAYMENT", payment.id, `application ${application.id} amount`, application.amountDecimal);
    if (applicationAmount === null) applicationValuesComplete = false;
    else applicationTotal = addDecimal(applicationTotal, applicationAmount, moneyFormat);
    if (application.invoice.customerId !== payment.customerId) {
      issue(run, "PAYMENT", payment.id, "CROSS_CUSTOMER_APPLICATION", `application ${application.id} invoice customer differs from payment`);
    }
    if (application.invoice.currencyCode !== null && payment.currencyCode !== null && application.invoice.currencyCode !== payment.currencyCode) {
      issue(run, "PAYMENT", payment.id, "CROSS_CURRENCY_APPLICATION", `application ${application.id} invoice currency differs from payment`);
    }
  }
  if (applicationValuesComplete && amount !== null && compareDecimal(applicationTotal, amount, moneyFormat) > 0) {
    issue(run, "PAYMENT", payment.id, "APPLICATIONS_EXCEED_PAYMENT", `payment ${payment.id} applications exceed amount`);
  }
}

async function scan<Entity extends { readonly id: string }>(
  run: MutableRun,
  entityKey: EntityKey,
  entityType: EntityType,
  options: z.output<typeof FinancialReconciliationOptionsSchema>,
  fetchAfter: (afterId: string | null, limit: number) => Promise<readonly Entity[]>,
  check: (entity: Entity) => void
): Promise<void> {
  let cursor: string | null = null;
  for (let batch = 0; batch < options.maxBatchesPerEntity; batch += 1) {
    const rows = await fetchAfter(cursor, options.batchSize);
    if (rows.length > options.batchSize) {
      issue(
        run,
        entityType,
        rows[0]?.id ?? "page",
        "UNBOUNDED_PAGE",
        `${entityKey} repository returned more rows than the requested page size`
      );
      run.complete = false;
      return;
    }
    let previous = cursor;
    for (const row of rows) {
      if ((previous !== null && row.id <= previous) || (previous === null && row.id.length === 0)) {
        issue(run, entityType, row.id || "unknown", "UNSTABLE_PAGINATION", `${entityKey} repository did not return primary-key ordered rows`);
        run.complete = false;
        return;
      }
      previous = row.id;
      check(row);
      run.scanned[entityKey] += 1;
    }
    if (rows.length < options.batchSize) return;
    cursor = rows.at(-1)?.id ?? cursor;
    if (batch + 1 === options.maxBatchesPerEntity) {
      const more = await fetchAfter(cursor, 1);
      if (more.length > 0) {
        run.complete = false;
        run.cursors[entityKey] = cursor;
      }
    }
  }
}

export async function runFinancialReconciliation(
  rawOptions: FinancialReconciliationOptions = {},
  dependencies: { readonly repository: FinancialReconciliationRepository } = { repository: createPrismaFinancialReconciliationRepository() }
): Promise<FinancialReconciliationResult> {
  const options = FinancialReconciliationOptionsSchema.parse(rawOptions);
  const run: MutableRun = {
    complete: true,
    issues: [],
    scanned: { products: 0, rates: 0, orders: 0, invoices: 0, payments: 0 },
    cursors: { products: null, rates: null, orders: null, invoices: null, payments: null },
  };
  const repository = dependencies.repository;
  await scan(run, "products", "PRODUCT", options, repository.fetchProducts.bind(repository), (row) => checkProducts(run, row));
  await scan(run, "rates", "RATE", options, repository.fetchRates.bind(repository), (row) => checkRates(run, row));
  await scan(run, "orders", "ORDER", options, repository.fetchOrders.bind(repository), (row) => checkOrders(run, row));
  await scan(run, "invoices", "INVOICE", options, repository.fetchInvoices.bind(repository), (row) => checkInvoices(run, row));
  await scan(run, "payments", "PAYMENT", options, repository.fetchPayments.bind(repository), (row) => checkPayments(run, row));
  run.issues.sort((left, right) =>
    `${left.entityType}:${left.entityId}:${left.code}`.localeCompare(`${right.entityType}:${right.entityId}:${right.code}`)
  );
  return FinancialReconciliationResultSchema.parse({
    state: run.issues.length > 0 ? "VIOLATIONS" : run.complete ? "CLEAN" : "INCOMPLETE",
    complete: run.complete,
    scanned: run.scanned,
    cursors: run.cursors,
    issues: run.issues,
  });
}

export function createPrismaFinancialReconciliationRepository(): FinancialReconciliationRepository {
  return {
    fetchProducts(afterId, limit) {
      return prisma.product.findMany({ where: afterId === null ? undefined : { id: { gt: afterId } }, orderBy: { id: "asc" }, take: limit });
    },
    async fetchRates(afterId, limit) {
      const rates = await prisma.rate.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } }, orderBy: { id: "asc" }, take: limit, include: { product: true },
      });
      return rates.map((rate) => ({ ...rate, productCurrencyCode: rate.product.currencyCode }));
    },
    fetchOrders(afterId, limit) {
      return prisma.order.findMany({ where: afterId === null ? undefined : { id: { gt: afterId } }, orderBy: { id: "asc" }, take: limit, include: { items: true } });
    },
    fetchInvoices(afterId, limit) {
      return prisma.invoice.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } }, orderBy: { id: "asc" }, take: limit,
        include: { lines: true, applications: { include: { payment: true } } },
      });
    },
    fetchPayments(afterId, limit) {
      return prisma.payment.findMany({
        where: afterId === null ? undefined : { id: { gt: afterId } }, orderBy: { id: "asc" }, take: limit,
        include: { applications: { include: { invoice: true } } },
      });
    },
  };
}
