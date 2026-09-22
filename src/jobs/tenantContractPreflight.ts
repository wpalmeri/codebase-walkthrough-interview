import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";

/**
 * Read-only evidence required before a future SQLite table-rebuild migration
 * makes tenant ownership required and replaces global SKU/invoice uniqueness.
 *
 * Each database query is a fixed SELECT or PRAGMA. The preflight deliberately
 * does not attempt a repair: operators must resolve every reported violation
 * before a maintenance-only contract migration can be scheduled.
 */
export const MAX_TENANT_CONTRACT_PREFLIGHT_SAMPLES = 25;
export const MAX_TENANT_CONTRACT_PREFLIGHT_COUNT = 1_000_000;
const MAX_SAMPLE_LENGTH = 512;
const SQLITE_INTEGRITY_ERROR_LIMIT = 100;

const issueCodes = [
  "MISSING_TENANT_CUSTOMER",
  "MISSING_TENANT_PRODUCT",
  "MISSING_TENANT_COMBO_DISCOUNT",
  "MISSING_TENANT_ORDER",
  "MISSING_TENANT_INVOICE",
  "MISSING_TENANT_PAYMENT",
  "MISSING_TENANT_IDEMPOTENCY_RECORD",
  "RATE_CUSTOMER_PRODUCT_TENANT_MISMATCH",
  "ORDER_CUSTOMER_TENANT_MISMATCH",
  "INVOICE_CUSTOMER_TENANT_MISMATCH",
  "INVOICE_ORDER_TENANT_MISMATCH",
  "PAYMENT_CUSTOMER_TENANT_MISMATCH",
  "PAYMENT_APPLICATION_TENANT_MISMATCH",
  "DUPLICATE_PRODUCT_SKU_PER_TENANT",
  "DUPLICATE_INVOICE_NUMBER_PER_TENANT",
  "FOREIGN_KEY_VIOLATION",
  "SQLITE_INTEGRITY_VIOLATION",
] as const;

export const TenantContractPreflightIssueCodeSchema = z.enum(issueCodes);
export type TenantContractPreflightIssueCode = z.infer<typeof TenantContractPreflightIssueCodeSchema>;

export const TenantContractPreflightIssueSchema = z.strictObject({
  code: TenantContractPreflightIssueCodeSchema,
  /** A capped count: see countTruncated before treating this as an exact total. */
  count: z.number().int().min(1).max(MAX_TENANT_CONTRACT_PREFLIGHT_COUNT),
  countTruncated: z.boolean(),
  /** Deterministic, length-bounded identifiers for the first affected rows. */
  samples: z.array(z.string().min(1).max(MAX_SAMPLE_LENGTH)).max(MAX_TENANT_CONTRACT_PREFLIGHT_SAMPLES),
});
export type TenantContractPreflightIssue = z.infer<typeof TenantContractPreflightIssueSchema>;

export const TenantContractPreflightResultSchema = z.strictObject({
  state: z.enum(["READY", "BLOCKED"]),
  ready: z.boolean(),
  issues: z.array(TenantContractPreflightIssueSchema).max(issueCodes.length),
});
export type TenantContractPreflightResult = z.infer<typeof TenantContractPreflightResultSchema>;

export const TenantContractPreflightOptionsSchema = z.strictObject({
  maxIssueSamples: z.number().int().min(1).max(MAX_TENANT_CONTRACT_PREFLIGHT_SAMPLES).default(10),
});
export type TenantContractPreflightOptions = z.input<typeof TenantContractPreflightOptionsSchema>;

export interface TenantContractPreflightQueryClient {
  $queryRaw(query: Prisma.Sql): Promise<unknown>;
}

export interface TenantContractPreflightDependencies {
  readonly client?: TenantContractPreflightQueryClient;
}

interface CountedCheck {
  readonly code: Exclude<TenantContractPreflightIssueCode, "FOREIGN_KEY_VIOLATION" | "SQLITE_INTEGRITY_VIOLATION">;
  readonly countQuery: Prisma.Sql;
  sampleQuery(limit: number): Prisma.Sql;
}

const CountRowSchema = z.object({
  count: z.union([z.number(), z.bigint(), z.string()]),
}).passthrough();
const SampleRowSchema = z.object({ sample: z.unknown() }).passthrough();

function table(name: string): Prisma.Sql {
  return Prisma.raw(`"${name}"`);
}

function nullTenantCheck(
  code: CountedCheck["code"],
  tableName: "Customer" | "Product" | "ComboDiscount" | "Order" | "Invoice" | "Payment" | "IdempotencyRecord"
): CountedCheck {
  const source = table(tableName);
  return {
    code,
    countQuery: Prisma.sql`SELECT COUNT(*) AS count FROM ${source} WHERE "tenantId" IS NULL`,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM ${source}
      WHERE "tenantId" IS NULL
      ORDER BY "id" ASC
      LIMIT ${limit}
    `,
  };
}

const countedChecks: readonly CountedCheck[] = [
  nullTenantCheck("MISSING_TENANT_CUSTOMER", "Customer"),
  nullTenantCheck("MISSING_TENANT_PRODUCT", "Product"),
  nullTenantCheck("MISSING_TENANT_COMBO_DISCOUNT", "ComboDiscount"),
  nullTenantCheck("MISSING_TENANT_ORDER", "Order"),
  nullTenantCheck("MISSING_TENANT_INVOICE", "Invoice"),
  nullTenantCheck("MISSING_TENANT_PAYMENT", "Payment"),
  nullTenantCheck("MISSING_TENANT_IDEMPOTENCY_RECORD", "IdempotencyRecord"),
  {
    code: "RATE_CUSTOMER_PRODUCT_TENANT_MISMATCH",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Rate"
      INNER JOIN "Customer" ON "Customer"."id" = "Rate"."customerId"
      INNER JOIN "Product" ON "Product"."id" = "Rate"."productId"
      WHERE NOT ("Customer"."tenantId" IS "Product"."tenantId")
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("Rate"."id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM "Rate"
      INNER JOIN "Customer" ON "Customer"."id" = "Rate"."customerId"
      INNER JOIN "Product" ON "Product"."id" = "Rate"."productId"
      WHERE NOT ("Customer"."tenantId" IS "Product"."tenantId")
      ORDER BY "Rate"."id" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "ORDER_CUSTOMER_TENANT_MISMATCH",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Order"
      INNER JOIN "Customer" ON "Customer"."id" = "Order"."customerId"
      WHERE NOT ("Order"."tenantId" IS "Customer"."tenantId")
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("Order"."id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM "Order"
      INNER JOIN "Customer" ON "Customer"."id" = "Order"."customerId"
      WHERE NOT ("Order"."tenantId" IS "Customer"."tenantId")
      ORDER BY "Order"."id" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "INVOICE_CUSTOMER_TENANT_MISMATCH",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Invoice"
      INNER JOIN "Customer" ON "Customer"."id" = "Invoice"."customerId"
      WHERE NOT ("Invoice"."tenantId" IS "Customer"."tenantId")
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("Invoice"."id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM "Invoice"
      INNER JOIN "Customer" ON "Customer"."id" = "Invoice"."customerId"
      WHERE NOT ("Invoice"."tenantId" IS "Customer"."tenantId")
      ORDER BY "Invoice"."id" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "INVOICE_ORDER_TENANT_MISMATCH",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Invoice"
      INNER JOIN "Order" ON "Order"."id" = "Invoice"."orderId"
      WHERE NOT ("Invoice"."tenantId" IS "Order"."tenantId")
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("Invoice"."id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM "Invoice"
      INNER JOIN "Order" ON "Order"."id" = "Invoice"."orderId"
      WHERE NOT ("Invoice"."tenantId" IS "Order"."tenantId")
      ORDER BY "Invoice"."id" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "PAYMENT_CUSTOMER_TENANT_MISMATCH",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "Payment"
      INNER JOIN "Customer" ON "Customer"."id" = "Payment"."customerId"
      WHERE NOT ("Payment"."tenantId" IS "Customer"."tenantId")
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("Payment"."id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM "Payment"
      INNER JOIN "Customer" ON "Customer"."id" = "Payment"."customerId"
      WHERE NOT ("Payment"."tenantId" IS "Customer"."tenantId")
      ORDER BY "Payment"."id" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "PAYMENT_APPLICATION_TENANT_MISMATCH",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count
      FROM "PaymentApplication"
      INNER JOIN "Payment" ON "Payment"."id" = "PaymentApplication"."paymentId"
      INNER JOIN "Invoice" ON "Invoice"."id" = "PaymentApplication"."invoiceId"
      WHERE NOT ("Payment"."tenantId" IS "Invoice"."tenantId")
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT substr(CAST("PaymentApplication"."id" AS TEXT), 1, ${MAX_SAMPLE_LENGTH}) AS sample
      FROM "PaymentApplication"
      INNER JOIN "Payment" ON "Payment"."id" = "PaymentApplication"."paymentId"
      INNER JOIN "Invoice" ON "Invoice"."id" = "PaymentApplication"."invoiceId"
      WHERE NOT ("Payment"."tenantId" IS "Invoice"."tenantId")
      ORDER BY "PaymentApplication"."id" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "DUPLICATE_PRODUCT_SKU_PER_TENANT",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM "Product"
        WHERE "tenantId" IS NOT NULL
        GROUP BY "tenantId", "sku"
        HAVING COUNT(*) > 1
      )
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT
        substr(CAST("tenantId" AS TEXT), 1, ${Math.floor(MAX_SAMPLE_LENGTH / 2)}) AS tenantId,
        substr(CAST("sku" AS TEXT), 1, ${Math.floor(MAX_SAMPLE_LENGTH / 2)}) AS businessKey
      FROM "Product"
      WHERE "tenantId" IS NOT NULL
      GROUP BY "tenantId", "sku"
      HAVING COUNT(*) > 1
      ORDER BY "tenantId" ASC, "sku" ASC
      LIMIT ${limit}
    `,
  },
  {
    code: "DUPLICATE_INVOICE_NUMBER_PER_TENANT",
    countQuery: Prisma.sql`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM "Invoice"
        WHERE "tenantId" IS NOT NULL
        GROUP BY "tenantId", "number"
        HAVING COUNT(*) > 1
      )
    `,
    sampleQuery: (limit) => Prisma.sql`
      SELECT
        substr(CAST("tenantId" AS TEXT), 1, ${Math.floor(MAX_SAMPLE_LENGTH / 2)}) AS tenantId,
        substr(CAST("number" AS TEXT), 1, ${Math.floor(MAX_SAMPLE_LENGTH / 2)}) AS businessKey
      FROM "Invoice"
      WHERE "tenantId" IS NOT NULL
      GROUP BY "tenantId", "number"
      HAVING COUNT(*) > 1
      ORDER BY "tenantId" ASC, "number" ASC
      LIMIT ${limit}
    `,
  },
];

function boundedCount(value: unknown): Pick<TenantContractPreflightIssue, "count" | "countTruncated"> {
  let count: bigint;
  try {
    count = typeof value === "bigint" ? value : BigInt(String(value));
  } catch {
    throw new Error("tenant contract preflight received an invalid aggregate count");
  }
  if (count < 0n) throw new Error("tenant contract preflight received a negative aggregate count");
  const maximum = BigInt(MAX_TENANT_CONTRACT_PREFLIGHT_COUNT);
  return {
    count: Number(count > maximum ? maximum : count),
    countTruncated: count > maximum,
  };
}

function boundedSample(value: unknown): string {
  const sample = String(value);
  return sample.length > MAX_SAMPLE_LENGTH ? sample.slice(0, MAX_SAMPLE_LENGTH) : sample;
}

function sampleFromRow(row: unknown): string {
  const parsed = z.object({ tenantId: z.unknown(), businessKey: z.unknown() }).passthrough().safeParse(row);
  if (parsed.success) return boundedSample(`${String(parsed.data.tenantId)}:${String(parsed.data.businessKey)}`);
  const directSample = SampleRowSchema.safeParse(row);
  // Every fixed query above aliases an explicit, SQL-truncated sample. If a
  // driver unexpectedly changes that shape, retain a bounded diagnostic rather
  // than serializing arbitrary corrupt database data into the operator report.
  return directSample.success ? boundedSample(directSample.data.sample) : "<unparseable sample>";
}

async function countedIssue(
  client: TenantContractPreflightQueryClient,
  check: CountedCheck,
  limit: number
): Promise<TenantContractPreflightIssue | undefined> {
  const countRows = z.array(z.unknown()).parse(await client.$queryRaw(check.countQuery));
  if (countRows.length !== 1) throw new Error(`tenant contract preflight ${check.code} did not return one count row`);
  const counted = boundedCount(CountRowSchema.parse(countRows[0]).count);
  if (counted.count === 0 && !counted.countTruncated) return undefined;
  const rows = z.array(z.unknown()).parse(await client.$queryRaw(check.sampleQuery(limit)));
  return TenantContractPreflightIssueSchema.parse({
    code: check.code,
    ...counted,
    samples: rows.map(sampleFromRow).filter((sample) => sample.length > 0).slice(0, limit),
  });
}

async function foreignKeyIssue(
  client: TenantContractPreflightQueryClient,
  limit: number
): Promise<TenantContractPreflightIssue | undefined> {
  const countRows = z.array(z.unknown()).parse(
    await client.$queryRaw(Prisma.sql`SELECT COUNT(*) AS count FROM pragma_foreign_key_check`)
  );
  if (countRows.length !== 1) throw new Error("tenant contract preflight foreign-key check did not return one count row");
  const counted = boundedCount(CountRowSchema.parse(countRows[0]).count);
  if (counted.count === 0 && !counted.countTruncated) return undefined;
  const rows = z.array(z.unknown()).parse(await client.$queryRaw(Prisma.sql`
    SELECT
      substr(CAST("table" AS TEXT), 1, 180) AS tableName,
      substr(CAST("rowid" AS TEXT), 1, 160) AS rowId,
      substr(CAST("parent" AS TEXT), 1, 160) AS parentName,
      substr(CAST("fkid" AS TEXT), 1, 10) AS foreignKeyId
    FROM pragma_foreign_key_check
    ORDER BY "table" ASC, "rowid" ASC, "fkid" ASC
    LIMIT ${limit}
  `));
  const samples = rows.map((row) => {
    const parsed = z.object({ tableName: z.unknown(), rowId: z.unknown(), parentName: z.unknown(), foreignKeyId: z.unknown() }).passthrough().parse(row);
    return boundedSample(`${String(parsed.tableName)}#${String(parsed.rowId)}->${String(parsed.parentName)}:${String(parsed.foreignKeyId)}`);
  });
  return TenantContractPreflightIssueSchema.parse({
    code: "FOREIGN_KEY_VIOLATION",
    ...counted,
    samples: samples.filter((sample) => sample.length > 0).slice(0, limit),
  });
}

async function integrityIssue(client: TenantContractPreflightQueryClient, limit: number): Promise<TenantContractPreflightIssue | undefined> {
  // SQLite itself caps this PRAGMA's returned errors before we materialize them.
  const rows = z.array(z.unknown()).parse(
    await client.$queryRaw(Prisma.raw(`PRAGMA integrity_check(${SQLITE_INTEGRITY_ERROR_LIMIT})`))
  );
  const messages = rows
    .map((row) => Object.values(z.object({}).passthrough().parse(row))[0])
    .map(boundedSample)
    .filter((message) => message.toLowerCase() !== "ok");
  if (messages.length === 0) return undefined;
  return TenantContractPreflightIssueSchema.parse({
    code: "SQLITE_INTEGRITY_VIOLATION",
    count: Math.min(messages.length, MAX_TENANT_CONTRACT_PREFLIGHT_COUNT),
    countTruncated: messages.length >= SQLITE_INTEGRITY_ERROR_LIMIT,
    samples: messages.slice(0, limit),
  });
}

/** Runs fixed read-only SQLite checks and returns only bounded evidence. */
export async function runTenantContractPreflight(
  options: TenantContractPreflightOptions = {},
  dependencies: TenantContractPreflightDependencies = {}
): Promise<TenantContractPreflightResult> {
  const parsedOptions = TenantContractPreflightOptionsSchema.parse(options);
  const client = dependencies.client ?? prisma;
  const issues = (await Promise.all([
    ...countedChecks.map((check) => countedIssue(client, check, parsedOptions.maxIssueSamples)),
    foreignKeyIssue(client, parsedOptions.maxIssueSamples),
    integrityIssue(client, parsedOptions.maxIssueSamples),
  ])).filter((issue): issue is TenantContractPreflightIssue => issue !== undefined);

  return TenantContractPreflightResultSchema.parse({
    state: issues.length === 0 ? "READY" : "BLOCKED",
    ready: issues.length === 0,
    issues,
  });
}
