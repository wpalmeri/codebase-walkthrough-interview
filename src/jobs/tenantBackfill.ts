import { prisma } from "../db";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  LEGACY_DEFAULT_TENANT_ID,
  LEGACY_DEFAULT_TENANT_NAME,
  LEGACY_DEFAULT_TENANT_SLUG,
} from "../tenancy/constants";

/**
 * The one tenant to which pre-tenancy data may be assigned. The slug is the
 * human-facing stable identity; the explicit ID makes runs deterministic when
 * it is created for the first time.
 */
export {
  LEGACY_DEFAULT_TENANT_ID,
  LEGACY_DEFAULT_TENANT_NAME,
  LEGACY_DEFAULT_TENANT_SLUG,
} from "../tenancy/constants";

export const TENANT_BACKFILL_STAGES = [
  "TENANT",
  "CUSTOMER",
  "PRODUCT",
  "COMBO_DISCOUNT",
  "ORDER",
  "INVOICE",
  "PAYMENT",
  "IDEMPOTENCY_RECORD",
  "ACCOUNTING_CONTROL",
] as const;
export const TenantBackfillStageSchema = z.enum(TENANT_BACKFILL_STAGES);
export type TenantBackfillStage = z.infer<typeof TenantBackfillStageSchema>;

export const TenantBackfillIssueCodeSchema = z.enum([
  "CONFLICTING_ACCOUNTING_CONTROL",
  "CONFLICTING_CUSTOMER_OWNERSHIP",
  "CONFLICTING_INVOICE_OWNERSHIP",
  "CONFLICTING_ORDER_OWNERSHIP",
  "CONFLICTING_PAYMENT_OWNERSHIP",
  "CONFLICTING_PRODUCT_OWNERSHIP",
  "MULTIPLE_RELATED_TENANTS",
  "LEGACY_DEFAULT_TENANT_IDENTITY_CONFLICT",
  "OWNERSHIP_CHANGED_DURING_BACKFILL",
  "RELATED_TO_NON_LEGACY_TENANT",
  "UNSTABLE_PRIMARY_KEY_ORDER",
]);
export type TenantBackfillIssueCode = z.infer<typeof TenantBackfillIssueCodeSchema>;

const TenantBackfillStopSchema = z.strictObject({
  code: TenantBackfillIssueCodeSchema,
  detail: z.string().min(1),
  rowId: z.string().min(1).optional(),
});

export const TenantBackfillStageResultSchema = z.strictObject({
  state: z.enum(["COMPLETE", "PARTIAL"]),
  checkpoint: z.string().nullable(),
  batches: z.number().int().nonnegative(),
  rowsRead: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
  stop: TenantBackfillStopSchema.optional(),
});
export type TenantBackfillStageResult = z.infer<typeof TenantBackfillStageResultSchema>;

export const TenantBackfillResultSchema = z.strictObject({
  state: z.enum(["COMPLETE", "PARTIAL"]),
  dryRun: z.boolean(),
  tenantId: z.string().min(1).nullable(),
  stages: z.array(
    z.strictObject({
      name: TenantBackfillStageSchema,
      result: TenantBackfillStageResultSchema,
    })
  ),
});
export type TenantBackfillResult = z.infer<typeof TenantBackfillResultSchema>;

export const TenantBackfillOptionsSchema = z.strictObject({
  batchSize: z.number().int().min(1).max(10_000).default(100),
  /** Preview is deliberate: the operator must opt into ownership assignment. */
  dryRun: z.boolean().default(true),
});
export type TenantBackfillOptions = z.input<typeof TenantBackfillOptionsSchema>;

interface RelationshipEvidence {
  readonly kind: "COMBO_DISCOUNT" | "CUSTOMER" | "PRODUCT" | "ORDER" | "INVOICE" | "PAYMENT";
  readonly tenantId: string | null;
}

interface BackfillRow {
  readonly id: string;
  readonly relationships: readonly RelationshipEvidence[];
}

interface StageDefinition {
  readonly name: Exclude<TenantBackfillStage, "ACCOUNTING_CONTROL" | "TENANT">;
  readonly checkpointJob: string;
  fetch(afterId: string | null, limit: number): Promise<readonly BackfillRow[]>;
  assign(transaction: Prisma.TransactionClient, ids: readonly string[], tenantId: string): Promise<number>;
}

const jobName = (stage: TenantBackfillStage): string => `tenant-ownership-${stage.toLowerCase()}-v1`;

class TenantBackfillHalt extends Error {
  constructor(
    readonly code: TenantBackfillIssueCode,
    readonly detail: string,
    readonly rowId?: string
  ) {
    super(detail);
  }
}

function ownershipStop(row: BackfillRow, tenantId: string): TenantBackfillHalt | undefined {
  const populated = row.relationships.filter(
    (relationship): relationship is RelationshipEvidence & { tenantId: string } =>
      relationship.tenantId !== null
  );
  const tenants = new Set(populated.map((relationship) => relationship.tenantId));
  if (tenants.size > 1) {
    return new TenantBackfillHalt(
      "MULTIPLE_RELATED_TENANTS",
      `legacy row ${row.id} is related to multiple tenant-owned records`,
      row.id
    );
  }
  const [relatedTenantId] = tenants;
  if (relatedTenantId === undefined || relatedTenantId === tenantId) return undefined;
  const specific = populated.find((relationship) => relationship.tenantId === relatedTenantId)?.kind;
  const codeByKind: Record<RelationshipEvidence["kind"], TenantBackfillIssueCode> = {
    COMBO_DISCOUNT: "RELATED_TO_NON_LEGACY_TENANT",
    CUSTOMER: "CONFLICTING_CUSTOMER_OWNERSHIP",
    PRODUCT: "CONFLICTING_PRODUCT_OWNERSHIP",
    ORDER: "CONFLICTING_ORDER_OWNERSHIP",
    INVOICE: "CONFLICTING_INVOICE_OWNERSHIP",
    PAYMENT: "CONFLICTING_PAYMENT_OWNERSHIP",
  };
  return new TenantBackfillHalt(
    specific === undefined ? "RELATED_TO_NON_LEGACY_TENANT" : codeByKind[specific],
    `legacy row ${row.id} is related to a ${specific?.toLowerCase() ?? "business"} record owned by tenant ${relatedTenantId}`,
    row.id
  );
}

function assertOrdered(rows: readonly BackfillRow[], checkpoint: string | null): TenantBackfillHalt | undefined {
  let previous = checkpoint;
  for (const row of rows) {
    if (previous !== null && row.id <= previous) {
      return new TenantBackfillHalt(
        "UNSTABLE_PRIMARY_KEY_ORDER",
        "repository returned rows outside strict primary-key checkpoint order",
        row.id
      );
    }
    previous = row.id;
  }
  return undefined;
}

const stages: readonly StageDefinition[] = [
  {
    name: "CUSTOMER",
    checkpointJob: jobName("CUSTOMER"),
    async fetch(afterId, limit) {
      const rows = await prisma.customer.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        include: {
          orders: { select: { tenantId: true } },
          invoices: { select: { tenantId: true } },
          payments: { select: { tenantId: true } },
          comboDiscounts: { select: { tenantId: true } },
          rates: { select: { product: { select: { tenantId: true } } } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        relationships: [
          ...row.orders.map((value) => ({ kind: "ORDER" as const, tenantId: value.tenantId })),
          ...row.invoices.map((value) => ({ kind: "INVOICE" as const, tenantId: value.tenantId })),
          ...row.payments.map((value) => ({ kind: "PAYMENT" as const, tenantId: value.tenantId })),
          ...row.comboDiscounts.map((value) => ({ kind: "COMBO_DISCOUNT" as const, tenantId: value.tenantId })),
          ...row.rates.map((value) => ({ kind: "PRODUCT" as const, tenantId: value.product.tenantId })),
        ],
      }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.customer.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
  {
    name: "PRODUCT",
    checkpointJob: jobName("PRODUCT"),
    async fetch(afterId, limit) {
      const rows = await prisma.product.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        include: {
          rates: { select: { customer: { select: { tenantId: true } } } },
          orderItems: { select: { order: { select: { tenantId: true } }, rate: { select: { customer: { select: { tenantId: true } } } } } },
          combos: { select: { tenantId: true, customer: { select: { tenantId: true } } } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        relationships: [
          ...row.rates.map((value) => ({ kind: "CUSTOMER" as const, tenantId: value.customer.tenantId })),
          ...row.orderItems.flatMap((value) => [
            { kind: "ORDER" as const, tenantId: value.order.tenantId },
            { kind: "CUSTOMER" as const, tenantId: value.rate.customer.tenantId },
          ]),
          ...row.combos.flatMap((value) => [
            { kind: "COMBO_DISCOUNT" as const, tenantId: value.tenantId },
            { kind: "CUSTOMER" as const, tenantId: value.customer?.tenantId ?? null },
          ]),
        ],
      }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.product.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
  {
    name: "COMBO_DISCOUNT",
    checkpointJob: jobName("COMBO_DISCOUNT"),
    async fetch(afterId, limit) {
      const rows = await prisma.comboDiscount.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        include: { customer: { select: { tenantId: true } }, products: { select: { tenantId: true } } },
      });
      return rows.map((row) => ({
        id: row.id,
        relationships: [
          { kind: "CUSTOMER" as const, tenantId: row.customer?.tenantId ?? null },
          ...row.products.map((value) => ({ kind: "PRODUCT" as const, tenantId: value.tenantId })),
        ],
      }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.comboDiscount.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
  {
    name: "ORDER",
    checkpointJob: jobName("ORDER"),
    async fetch(afterId, limit) {
      const rows = await prisma.order.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        include: {
          customer: { select: { tenantId: true } },
          invoice: { select: { tenantId: true } },
          items: { select: { product: { select: { tenantId: true } }, rate: { select: { customer: { select: { tenantId: true } } } } } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        relationships: [
          { kind: "CUSTOMER" as const, tenantId: row.customer.tenantId },
          { kind: "INVOICE" as const, tenantId: row.invoice?.tenantId ?? null },
          ...row.items.flatMap((value) => [
            { kind: "PRODUCT" as const, tenantId: value.product.tenantId },
            { kind: "CUSTOMER" as const, tenantId: value.rate.customer.tenantId },
          ]),
        ],
      }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.order.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
  {
    name: "INVOICE",
    checkpointJob: jobName("INVOICE"),
    async fetch(afterId, limit) {
      const rows = await prisma.invoice.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        include: {
          customer: { select: { tenantId: true } },
          order: { select: { tenantId: true } },
          applications: { select: { payment: { select: { tenantId: true } } } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        relationships: [
          { kind: "CUSTOMER" as const, tenantId: row.customer.tenantId },
          { kind: "ORDER" as const, tenantId: row.order.tenantId },
          ...row.applications.map((value) => ({ kind: "PAYMENT" as const, tenantId: value.payment.tenantId })),
        ],
      }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.invoice.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
  {
    name: "PAYMENT",
    checkpointJob: jobName("PAYMENT"),
    async fetch(afterId, limit) {
      const rows = await prisma.payment.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        include: {
          customer: { select: { tenantId: true } },
          applications: { select: { invoice: { select: { tenantId: true } } } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        relationships: [
          { kind: "CUSTOMER" as const, tenantId: row.customer.tenantId },
          ...row.applications.map((value) => ({ kind: "INVOICE" as const, tenantId: value.invoice.tenantId })),
        ],
      }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.payment.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
  {
    name: "IDEMPOTENCY_RECORD",
    checkpointJob: jobName("IDEMPOTENCY_RECORD"),
    async fetch(afterId, limit) {
      const rows = await prisma.idempotencyRecord.findMany({
        where: { tenantId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
        orderBy: { id: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((row) => ({ id: row.id, relationships: [] }));
    },
    async assign(transaction, ids, tenantId) {
      const result = await transaction.idempotencyRecord.updateMany({ where: { id: { in: [...ids] }, tenantId: null }, data: { tenantId } });
      return result.count;
    },
  },
];

function legacyTenantFromCandidates(
  byId: { readonly id: string; readonly slug: string; readonly name: string } | null,
  bySlug: { readonly id: string; readonly slug: string; readonly name: string } | null
): string | null {
  const candidates = [byId, bySlug].filter(
    (candidate): candidate is { readonly id: string; readonly slug: string; readonly name: string } => candidate !== null
  );
  if (candidates.length === 0) return null;
  if (
    candidates.some(
      (candidate) =>
        candidate.id !== LEGACY_DEFAULT_TENANT_ID ||
        candidate.slug !== LEGACY_DEFAULT_TENANT_SLUG ||
        candidate.name !== LEGACY_DEFAULT_TENANT_NAME
    )
  ) {
    throw new TenantBackfillHalt(
      "LEGACY_DEFAULT_TENANT_IDENTITY_CONFLICT",
      "the legacy-default tenant ID, slug, or name is already reserved by a different tenant"
    );
  }
  return LEGACY_DEFAULT_TENANT_ID;
}

async function findLegacyTenant(): Promise<string | null> {
  const [byId, bySlug] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: LEGACY_DEFAULT_TENANT_ID }, select: { id: true, slug: true, name: true } }),
    prisma.tenant.findUnique({ where: { slug: LEGACY_DEFAULT_TENANT_SLUG }, select: { id: true, slug: true, name: true } }),
  ]);
  return legacyTenantFromCandidates(byId, bySlug);
}

async function ensureLegacyTenant(): Promise<string> {
  const existing = await findLegacyTenant();
  if (existing !== null) return existing;
  try {
    const created = await prisma.tenant.create({
      data: { id: LEGACY_DEFAULT_TENANT_ID, slug: LEGACY_DEFAULT_TENANT_SLUG, name: LEGACY_DEFAULT_TENANT_NAME },
    });
    return legacyTenantFromCandidates(created, created) ?? LEGACY_DEFAULT_TENANT_ID;
  } catch (error) {
    // Another process may create the exact identity after our two reads. Reload
    // it, but never treat a conflicting unique value as a safe default tenant.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await findLegacyTenant();
      if (raced !== null) return raced;
    }
    throw error;
  }
}

async function runStage(
  definition: StageDefinition,
  tenantId: string,
  batchSize: number,
  dryRun: boolean,
  wait?: () => Promise<void>
): Promise<TenantBackfillStageResult> {
  let checkpoint = (await prisma.backfillCheckpoint.findUnique({ where: { jobName: definition.checkpointJob } }))?.lastId ?? null;
  let cursor = checkpoint;
  let batches = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  for (;;) {
    const rows = await definition.fetch(cursor, batchSize);
    const orderError = assertOrdered(rows, cursor);
    if (orderError !== undefined) return { state: "PARTIAL", checkpoint, batches, rowsRead, rowsWritten, stop: orderError };
    if (rows.length === 0) {
      if (!dryRun) {
        await prisma.backfillCheckpoint.upsert({
          where: { jobName: definition.checkpointJob },
          create: { jobName: definition.checkpointJob, lastId: checkpoint, completedAt: new Date() },
          update: { completedAt: new Date() },
        });
      }
      return { state: "COMPLETE", checkpoint, batches, rowsRead, rowsWritten };
    }
    for (const row of rows) {
      const halt = ownershipStop(row, tenantId);
      if (halt !== undefined) return { state: "PARTIAL", checkpoint, batches, rowsRead, rowsWritten, stop: halt };
    }
    const nextCheckpoint = rows.at(-1)?.id;
    if (nextCheckpoint === undefined) throw new Error("non-empty tenant batch has no checkpoint");
    if (!dryRun) {
      try {
        await prisma.$transaction(async (transaction) => {
          const ids = rows.map((row) => row.id);
          // Recheck with the conditional update. A concurrent dual-write may
          // claim a row; never overwrite its tenant ownership.
          const assigned = await definition.assign(transaction, ids, tenantId);
          if (assigned !== ids.length) {
            throw new TenantBackfillHalt(
              "OWNERSHIP_CHANGED_DURING_BACKFILL",
              "a row received tenant ownership while this batch was running",
              ids[0]
            );
          }
          await transaction.backfillCheckpoint.upsert({
            where: { jobName: definition.checkpointJob },
            create: { jobName: definition.checkpointJob, lastId: nextCheckpoint },
            update: { lastId: nextCheckpoint, completedAt: null },
          });
        });
      } catch (error) {
        if (error instanceof TenantBackfillHalt) {
          return { state: "PARTIAL", checkpoint, batches, rowsRead, rowsWritten, stop: error };
        }
        throw error;
      }
      checkpoint = nextCheckpoint;
      rowsWritten += rows.length;
    }
    cursor = nextCheckpoint;
    batches += 1;
    rowsRead += rows.length;
    if (wait !== undefined) await wait();
  }
}

async function copyAccountingControl(tenantId: string, dryRun: boolean): Promise<TenantBackfillStageResult> {
  const checkpointJob = jobName("ACCOUNTING_CONTROL");
  const existingCheckpoint = await prisma.backfillCheckpoint.findUnique({ where: { jobName: checkpointJob } });
  if (!dryRun && existingCheckpoint?.completedAt !== null && existingCheckpoint !== null) {
    return { state: "COMPLETE", checkpoint: existingCheckpoint.lastId, batches: 0, rowsRead: 0, rowsWritten: 0 };
  }
  const legacy = await prisma.accountingPeriodControl.findUnique({ where: { id: 1 } });
  const existing = await prisma.tenantAccountingPeriodControl.findUnique({ where: { tenantId } });
  if (existing !== null && existing.closedThroughDate !== (legacy?.closedThroughDate ?? null)) {
    return {
      state: "PARTIAL",
      checkpoint: existingCheckpoint?.lastId ?? null,
      batches: 0,
      rowsRead: legacy === null ? 0 : 1,
      rowsWritten: 0,
      stop: {
        code: "CONFLICTING_ACCOUNTING_CONTROL",
        detail: "legacy accounting close control disagrees with the legacy-default tenant control",
      },
    };
  }
  if (!dryRun) {
    await prisma.$transaction(async (transaction) => {
      if (existing === null) {
        await transaction.tenantAccountingPeriodControl.create({
          data: { tenantId, closedThroughDate: legacy?.closedThroughDate ?? null },
        });
      }
      await transaction.backfillCheckpoint.upsert({
        where: { jobName: checkpointJob },
        create: { jobName: checkpointJob, lastId: tenantId, completedAt: new Date() },
        update: { lastId: tenantId, completedAt: new Date() },
      });
    });
  }
  return {
    state: "COMPLETE",
    checkpoint: dryRun ? null : tenantId,
    batches: legacy === null ? 0 : 1,
    rowsRead: legacy === null ? 0 : 1,
    rowsWritten: !dryRun && existing === null ? 1 : 0,
  };
}

/**
 * Assigns only still-null legacy ownership in primary-key batches. Every batch
 * validates all reachable customer/product/order/invoice/payment edges before
 * it writes, then advances its existing BackfillCheckpoint in the same
 * transaction. A caller may inject wait to throttle production runs or stop a
 * test between committed batches.
 */
export async function runTenantBackfill(
  rawOptions: TenantBackfillOptions = {},
  dependencies: { readonly wait?: () => Promise<void> } = {}
): Promise<TenantBackfillResult> {
  const options = TenantBackfillOptionsSchema.parse(rawOptions);
  // Preview deliberately does not create the legacy tenant; it still uses the
  // deterministic first-creation ID to identify what would receive ownership.
  let tenantId: string;
  try {
    tenantId = options.dryRun ? LEGACY_DEFAULT_TENANT_ID : await ensureLegacyTenant();
  } catch (error) {
    if (error instanceof TenantBackfillHalt) {
      return {
        state: "PARTIAL",
        dryRun: options.dryRun,
        tenantId: null,
        stages: [
          {
            name: "TENANT",
            result: {
              state: "PARTIAL",
              checkpoint: null,
              batches: 0,
              rowsRead: 0,
              rowsWritten: 0,
              stop: error,
            },
          },
        ],
      };
    }
    throw error;
  }
  const results: TenantBackfillResult["stages"] = [];
  for (const stage of stages) {
    const result = await runStage(stage, tenantId, options.batchSize, options.dryRun, dependencies.wait);
    results.push({ name: stage.name, result });
    if (result.state === "PARTIAL") return { state: "PARTIAL", dryRun: options.dryRun, tenantId, stages: results };
  }
  const accounting = await copyAccountingControl(tenantId, options.dryRun);
  results.push({ name: "ACCOUNTING_CONTROL", result: accounting });
  return { state: accounting.state, dryRun: options.dryRun, tenantId, stages: results };
}
