import { prisma } from "../db";
import type { Prisma } from "@prisma/client";
import { ApplicationError, NotFoundError, PreconditionError } from "../errors";
import {
  formatResourceEtag,
  verifyResourceIfMatch,
  type ResourceVersionPreconditionFailure,
} from "../http/resourceVersion";
import {
  ComboDiscountModel,
  RateModel,
  toComboDiscountModel,
  toRateModel,
} from "../models/rate";
import {
  canonicalMoney,
  canonicalPercentage,
  legacyNumber,
  type DecimalInput,
} from "../domain/money";
import { serializeRateTiers, type RateTierInput } from "../domain/rateTier";
import { MoneyStringSchema, PercentageStringSchema, type MoneyString, type PercentageString } from "@meridian/contracts";

export interface DualWrittenMoney {
  readonly legacy: number;
  readonly decimal: MoneyString;
}

export interface DualWrittenPercentage {
  readonly legacy: number;
  readonly decimal: PercentageString;
}

/** Produces matching legacy and DECIMAL(19,4) values without rounding either write. */
export function dualWriteMoney(value: DecimalInput): DualWrittenMoney {
  const decimal = MoneyStringSchema.parse(canonicalMoney(value, "unit price"));
  return {
    legacy: legacyNumber(decimal, { scale: 4, precision: 19, field: "unit price" }),
    decimal,
  };
}

/** Produces matching legacy and DECIMAL(7,4) percentage values without rounding. */
export function dualWritePercentage(value: DecimalInput): DualWrittenPercentage {
  const decimal = PercentageStringSchema.parse(canonicalPercentage(value, "percent off"));
  return {
    legacy: legacyNumber(decimal, { scale: 4, precision: 7, field: "percent off" }),
    decimal,
  };
}

export interface RateUpdateData {
  readonly unitPrice: number;
  readonly unitPriceDecimal: MoneyString;
  readonly tiers?: ReturnType<typeof serializeRateTiers>;
}

/**
 * This intentionally builds only Rate columns. Callers use it as the update
 * boundary so rate changes cannot write or re-rate existing order snapshots.
 */
export function buildRateUpdateData(input: {
  unitPrice: DecimalInput;
  tiers?: RateTierInput[];
}): RateUpdateData {
  const price = dualWriteMoney(input.unitPrice);
  return {
    unitPrice: price.legacy,
    unitPriceDecimal: price.decimal,
    ...(input.tiers === undefined ? {} : { tiers: serializeRateTiers(input.tiers) }),
  };
}

async function requireTenantCustomer(tenantId: string, customerId: string): Promise<void> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { id: true },
  });
  if (customer === null) throw new NotFoundError();
}

function tenantRateWhere(tenantId: string, customerId?: string) {
  return {
    customer: { tenantId },
    product: { tenantId },
    ...(customerId === undefined ? {} : { customerId }),
  };
}

export async function listRates(tenantId: string, customerId?: string): Promise<RateModel[]> {
  if (customerId !== undefined) await requireTenantCustomer(tenantId, customerId);
  const rows = await prisma.rate.findMany({
    where: tenantRateWhere(tenantId, customerId),
    include: { product: true },
    orderBy: { effectiveDate: "asc" },
  });
  return rows.map(toRateModel);
}

export interface VersionedRate {
  readonly rate: RateModel;
  readonly etag: string;
}

/**
 * Reads one rate inside the authenticated tenant. A legacy null version is
 * intentionally exposed as logical version zero so old rows can opt into CAS
 * without an unsafe deploy-time data scan.
 */
export async function getVersionedRate(tenantId: string, rateId: string): Promise<VersionedRate> {
  const rate = await findTenantRate(prisma, tenantId, rateId);
  if (rate === null) throw new NotFoundError();
  return {
    rate: toRateModel(rate),
    etag: formatResourceEtag({ kind: "rate", id: rate.id, version: logicalResourceVersion(rate.resourceVersion) }),
  };
}

// Combos scoped to the tenant, optionally to a tenant customer plus its tenant-wide ones.
export async function listComboDiscounts(
  tenantId: string,
  customerId?: string
): Promise<ComboDiscountModel[]> {
  if (customerId !== undefined) await requireTenantCustomer(tenantId, customerId);
  const rows = await prisma.comboDiscount.findMany({
    where: {
      tenantId,
      // A malformed legacy row must not disclose a foreign customer ID. New
      // writes are also checked before insert and by the database guard.
      OR: [{ customerId: null }, { customer: { tenantId } }],
      ...(customerId === undefined
        ? {}
        : { AND: [{ OR: [{ customerId }, { customerId: null }] }] }),
    },
    include: { products: { where: { tenantId } } },
  });
  return rows.map(toComboDiscountModel);
}

export async function createComboDiscount(tenantId: string, input: {
  name: string;
  productIds: string[];
  percentOff: DecimalInput;
  customerId?: string | null;
}): Promise<ComboDiscountModel> {
  const percentOff = dualWritePercentage(input.percentOff);
  return prisma.$transaction(async (transaction) => {
    if (input.customerId !== undefined && input.customerId !== null) {
      const customer = await transaction.customer.findFirst({
        where: { id: input.customerId, tenantId },
        select: { id: true },
      });
      if (customer === null) throw new NotFoundError();
    }
    const productIds = [...new Set(input.productIds ?? [])];
    const products = await transaction.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true },
    });
    if (products.length !== productIds.length) throw new NotFoundError();

    const row = await transaction.comboDiscount.create({
      data: {
        tenantId,
        name: input.name,
        percentOff: percentOff.legacy,
        percentOffDecimal: percentOff.decimal,
        customerId: input.customerId ?? null,
        products: { connect: productIds.map((id) => ({ id })) },
      },
      include: { products: true },
    });
    return toComboDiscountModel(row);
  });
}

// Update a customer's rate. Existing captured order and invoice prices remain
// immutable; only future order pricing captures can use this commercial term.
export async function updateRate(
  tenantId: string,
  rateId: string,
  input: { unitPrice: DecimalInput; tiers?: RateTierInput[] }
): Promise<RateModel> {
  const result = await prisma.rate.updateMany({
    where: { id: rateId, ...tenantRateWhere(tenantId) },
    data: buildRateUpdateData(input),
  });
  if (result.count !== 1) throw new NotFoundError();
  const rate = await prisma.rate.findFirst({
    where: { id: rateId, ...tenantRateWhere(tenantId) },
    include: { product: true },
  });
  if (rate === null) throw new NotFoundError();
  return toRateModel(rate);
}

/**
 * Performs a tenant-scoped compare-and-swap update. The predicate includes the
 * stored nullable version, so two callers holding the same ETag cannot both
 * modify a legacy or already-versioned row.
 */
export async function updateRateConditionally(
  tenantId: string,
  rateId: string,
  input: { unitPrice: DecimalInput; tiers?: RateTierInput[] },
  ifMatch: string | undefined
): Promise<VersionedRate> {
  return prisma.$transaction(async (transaction) => {
    const existing = await findTenantRate(transaction, tenantId, rateId);
    // Resolve visibility before inspecting a precondition so foreign and
    // missing IDs remain indistinguishable to a tenant principal.
    if (existing === null) throw new NotFoundError();

    const currentVersion = logicalResourceVersion(existing.resourceVersion);
    const precondition = verifyResourceIfMatch(ifMatch, { kind: "rate", id: existing.id }, currentVersion);
    if (!precondition.ok) throwPrecondition(precondition);
    if (precondition.version === Number.MAX_SAFE_INTEGER) {
      throw new PreconditionError(
        "RESOURCE_VERSION_EXHAUSTED",
        "This resource version cannot be advanced safely"
      );
    }

    const nextVersion = precondition.version + 1;
    const result = await transaction.rate.updateMany({
      where: {
        id: existing.id,
        ...tenantRateWhere(tenantId),
        ...(existing.resourceVersion === null
          ? { resourceVersion: null }
          : { resourceVersion: precondition.version }),
      },
      data: {
        ...buildRateUpdateData(input),
        resourceVersion: nextVersion,
      },
    });
    if (result.count !== 1) {
      // A concurrent delete should retain the ordinary not-found shape. Every
      // other failed predicate is a stale representation, including an update
      // that initialized a formerly-null version.
      const stillVisible = await findTenantRate(transaction, tenantId, rateId);
      if (stillVisible === null) throw new NotFoundError();
      throw new PreconditionError("ETAG_VERSION_MISMATCH", "If-Match does not match the current resource version");
    }

    // This read stays in the same transaction as the CAS. Another writer
    // therefore cannot advance the row between the representation and its ETag.
    const updated = await findTenantRate(transaction, tenantId, rateId);
    if (updated === null) throw new NotFoundError();
    return {
      rate: toRateModel(updated),
      etag: formatResourceEtag({ kind: "rate", id: updated.id, version: nextVersion }),
    };
  });
}

function logicalResourceVersion(value: number | null): number {
  return value ?? 0;
}

function throwPrecondition(failure: ResourceVersionPreconditionFailure): never {
  if (failure.status === 412) throw new PreconditionError(failure.code, failure.detail);
  throw new ApplicationError({
    type:
      failure.status === 428
        ? "urn:meridian:problem:precondition-required"
        : "urn:meridian:problem:invalid-if-match",
    title: failure.status === 428 ? "Precondition Required" : "Bad Request",
    status: failure.status,
    code: failure.code,
    detail: failure.detail,
  });
}

async function findTenantRate(database: Pick<Prisma.TransactionClient, "rate">, tenantId: string, rateId: string) {
  return database.rate.findFirst({
    where: { id: rateId, ...tenantRateWhere(tenantId) },
    include: { product: true },
  });
}
