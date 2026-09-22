import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  canonicalPercentage,
  decimalOrLegacy,
  legacyNumber,
} from "../domain/money";
import {
  captureOrderPricing,
  exactPricingInput,
  repriceOrderPricingSnapshot,
  type CapturedOrderPricing,
} from "../domain/orderPricing";
import { parseRateTiers } from "../domain/rateTier";
import {
  ApplicationError,
  ConflictError,
  DomainInvariantError,
  NotFoundError,
  PreconditionError,
} from "../errors";
import {
  formatResourceEtag,
  verifyResourceIfMatch,
  type ResourceVersionPreconditionFailure,
} from "../http/resourceVersion";
import { OrderModel, toOrderModel } from "../models/order";
import {
  appendRequestAuditEvent,
  type RequestAuditAppender,
  type RequestAuditMetadata,
  RequestAuditMetadataSchema,
} from "../audit/requestAudit";
import type { AuditEventRepository } from "../audit/auditEvent";
import { syncDraftInvoiceInTransaction } from "./invoiceController";
import {
  fingerprintTenantPaginationBinding,
  formatPaginationCursor,
  InvoiceStatusSchema,
  OrderPageSchema,
  parsePaginationCursor,
  type ListOrdersV1Request,
  type OrderPage,
  type PaginationCursorFailureCode,
} from "@meridian/contracts";
import { z } from "zod";

const DEFAULT_BILLING_CURRENCY = "USD";
const invoiceStatus = InvoiceStatusSchema.enum;
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const quantityFormat = {
  scale: QUANTITY_SCALE,
  precision: QUANTITY_PRECISION,
  field: "quantity",
} as const;

const orderInclude = {
  customer: true,
  items: { include: { product: true } },
  invoice: true,
  comments: { orderBy: { createdAt: "asc" } },
} as const;

function orderReference(id: string): string {
  return `SO-${id.toUpperCase()}`;
}

export async function listOrders(tenantId: string): Promise<OrderModel[]> {
  const rows = await prisma.order.findMany({
    where: { tenantId },
    include: orderInclude,
    orderBy: { orderDate: "desc" },
  });
  return rows.map(toOrderModel);
}

const OrderCursorOrderingSchema = z.tuple([
  z.iso.datetime({ offset: true }),
  z.string().min(1).max(1_024),
]);

export type OrderPageResult =
  | { readonly ok: true; readonly page: OrderPage }
  | { readonly ok: false; readonly code: PaginationCursorFailureCode };

/**
 * Lists a v1 tenant-scoped order page in descending `(orderDate, id)` order.
 * The explicit id tie-breaker makes traversal deterministic for tied dates and
 * prevents an insert before the cursor boundary from duplicating later rows.
 */
export async function listOrdersPage(
  tenantId: string,
  query: ListOrdersV1Request["query"]
): Promise<OrderPageResult> {
  const filterFingerprint = fingerprintTenantPaginationBinding({}, tenantId);
  const parsedCursor = query.cursor === undefined
    ? undefined
    : parsePaginationCursor(query.cursor, { resource: "orders", filterFingerprint });
  if (parsedCursor !== undefined && !parsedCursor.ok) return parsedCursor;

  const ordering = parsedCursor === undefined
    ? undefined
    : OrderCursorOrderingSchema.safeParse(parsedCursor.ordering);
  if (ordering !== undefined && !ordering.success) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }

  const [orderDate, id] = ordering === undefined ? [] : ordering.data;
  const rows = await prisma.order.findMany({
    where: {
      tenantId,
      ...(orderDate === undefined || id === undefined
        ? {}
        : {
            OR: [
              { orderDate: { lt: new Date(orderDate) } },
              { orderDate: new Date(orderDate), id: { lt: id } },
            ],
          }),
    },
    include: orderInclude,
    orderBy: [{ orderDate: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > query.limit && lastRow !== undefined
    ? formatPaginationCursor({
        resource: "orders",
        filterFingerprint,
        ordering: [lastRow.orderDate.toISOString(), lastRow.id],
      })
    : null;
  return {
    ok: true,
    page: OrderPageSchema.parse({
      data: pageRows.map(toOrderModel),
      page: { limit: query.limit, nextCursor },
    }),
  };
}

export async function getOrder(tenantId: string, orderId: string): Promise<OrderModel> {
  const row = await prisma.order.findFirstOrThrow({
    where: { id: orderId, tenantId },
    include: orderInclude,
  });
  return toOrderModel(row);
}

/** Legacy null versions are deliberately exposed as logical version zero. */
export async function getVersionedOrder(tenantId: string, orderId: string): Promise<VersionedOrder> {
  const order = await findTenantOrder(prisma, tenantId, orderId);
  if (order === null) throw new NotFoundError();
  return {
    order: toOrderModel(order),
    etag: formatResourceEtag({ kind: "order", id: order.id, version: logicalResourceVersion(order.resourceVersion) }),
  };
}

type PricingTransaction = Prisma.TransactionClient;
type OrderAuditTransaction = Pick<Prisma.TransactionClient, "auditEvent">;
type OrderMutationInput = {
  customerId?: string;
  orderDate?: string;
  notes?: string;
  items?: { id: string; quantity: string | number }[];
  comment?: { author?: string; body: string };
};

export interface VersionedOrder {
  readonly order: OrderModel;
  readonly etag: string;
}

async function capturedOrderLines(
  transaction: PricingTransaction,
  input: {
    tenantId: string;
    customerId: string;
    items: readonly { productId: string; quantity: string | number }[];
    capturedAt: Date;
  }
): Promise<CapturedOrderPricing[]> {
  await transaction.customer.findFirstOrThrow({
    where: { id: input.customerId, tenantId: input.tenantId },
  });
  const productIds = input.items.map((item) => item.productId);
  const products = await transaction.product.findMany({
    where: { id: { in: productIds }, tenantId: input.tenantId },
  });
  if (products.length !== productIds.length) {
    throw new NotFoundError();
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const existingRates = await transaction.rate.findMany({
    where: {
      customerId: input.customerId,
      productId: { in: productIds },
      customer: { tenantId: input.tenantId },
      product: { tenantId: input.tenantId },
    },
  });
  const ratesByProductId = new Map(existingRates.map((rate) => [rate.productId, rate]));

  for (const productId of productIds) {
    if (ratesByProductId.has(productId)) continue;
    const product = productsById.get(productId);
    if (!product) {
      throw new NotFoundError();
    }
    const listPriceDecimal = decimalOrLegacy(
      { decimal: product.listPriceDecimal, legacy: product.listPrice },
      { ...moneyFormat, field: `product ${productId} list price` }
    );
    const rate = await transaction.rate.create({
      data: {
        customerId: input.customerId,
        productId,
        unitPrice: legacyNumber(listPriceDecimal, moneyFormat),
        unitPriceDecimal: listPriceDecimal,
        currencyCode: product.currencyCode ?? DEFAULT_BILLING_CURRENCY,
      },
    });
    ratesByProductId.set(productId, rate);
  }

  const discounts = await transaction.comboDiscount.findMany({
    where: {
      tenantId: input.tenantId,
      OR: [{ customerId: input.customerId }, { customerId: null }],
    },
    include: { products: true },
  });
  const productIdSet = new Set(productIds);
  const capturedAt = input.capturedAt.toISOString();

  return input.items.map((item) => {
    const product = productsById.get(item.productId);
    const rate = ratesByProductId.get(item.productId);
    if (!product || !rate) throw new Error(`Pricing data for product ${item.productId} is missing`);

    const applicableDiscounts = discounts.filter((discount) => {
      const discountProductIds = discount.products.map((candidate) => candidate.id);
      return (
        discountProductIds.includes(item.productId) &&
        discountProductIds.every((productId) => productIdSet.has(productId))
      );
    });
    const productCurrency = product.currencyCode ?? rate.currencyCode ?? DEFAULT_BILLING_CURRENCY;
    const rateCurrency = rate.currencyCode ?? product.currencyCode ?? DEFAULT_BILLING_CURRENCY;
    const baseUnitPrice = decimalOrLegacy(
      { decimal: rate.unitPriceDecimal, legacy: rate.unitPrice },
      { ...moneyFormat, field: `rate ${rate.id} unit price` }
    );

    return captureOrderPricing(
      exactPricingInput({
        product: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          currencyCode: productCurrency,
        },
        rate: {
          id: rate.id,
          currencyCode: rateCurrency,
          baseUnitPrice,
          tiers: parseRateTiers(rate.tiers),
        },
        quantity: item.quantity,
        discounts: applicableDiscounts.map((discount) => ({
          id: discount.id,
          name: discount.name,
          percentOff: canonicalPercentage(
            discount.percentOffDecimal ?? discount.percentOff,
            `discount ${discount.id} percentage`
          ),
        })),
        capturedAt,
      })
    );
  });
}

function orderItemCreateData(orderId: string, captured: CapturedOrderPricing) {
  return {
    orderId,
    productId: captured.productId,
    rateId: captured.rateId,
    quantity: legacyNumber(captured.quantityDecimal, quantityFormat),
    unitPrice: legacyNumber(captured.effectiveUnitPriceDecimal, moneyFormat),
    productSkuSnapshot: captured.productSkuSnapshot,
    productNameSnapshot: captured.productNameSnapshot,
    productUnitSnapshot: captured.productUnitSnapshot,
    quantityDecimal: captured.quantityDecimal,
    baseUnitPriceDecimal: captured.baseUnitPriceDecimal,
    effectiveUnitPriceDecimal: captured.effectiveUnitPriceDecimal,
    amountDecimal: captured.amountDecimal,
    pricingSnapshot: captured.pricingSnapshot as Prisma.InputJsonValue,
    pricingCapturedAt: new Date(captured.pricingCapturedAt),
    snapshotVersion: captured.snapshotVersion,
  };
}

export async function createOrder(tenantId: string, input: {
  customerId: string;
  items: { productId: string; quantity: string | number }[];
  notes?: string;
}, audit: RequestAuditMetadata, appendAudit: RequestAuditAppender = appendRequestAuditEvent): Promise<OrderModel> {
  const auditMetadata = requireOrderAudit(tenantId, audit);
  const orderId = randomUUID();
  await prisma.$transaction(async (transaction) => {
    const lines = await capturedOrderLines(transaction, {
      tenantId,
      customerId: input.customerId,
      items: input.items,
      capturedAt: new Date(),
    });
    const currencies = new Set(lines.map((line) => line.currencyCode));
    if (currencies.size !== 1) {
      throw new DomainInvariantError(
        "ORDER_CURRENCY_MISMATCH",
        "An order cannot contain multiple currencies"
      );
    }

    await transaction.order.create({
      data: {
        id: orderId,
        tenantId,
        reference: orderReference(orderId),
        customerId: input.customerId,
        notes: input.notes,
        currencyCode: lines[0]?.currencyCode,
      },
    });
    await transaction.orderItem.createMany({
      data: lines.map((line) => orderItemCreateData(orderId, line)),
    });
    await appendOrderAudit(transaction, auditMetadata, appendAudit, "ORDER_CREATED", orderId);
  });
  return getOrder(tenantId, orderId);
}

// Order terms are captured once. Quantity changes recalculate from those terms;
// changing the customer would require an explicit re-contracting workflow.
export async function saveOrder(
  tenantId: string,
  orderId: string,
  input: OrderMutationInput,
  audit: RequestAuditMetadata,
  appendAudit: RequestAuditAppender = appendRequestAuditEvent
): Promise<OrderModel> {
  const auditMetadata = requireOrderAudit(tenantId, audit);
  await prisma.$transaction(async (transaction) => {
    await saveOrderInTransaction(transaction, tenantId, orderId, input, auditMetadata, appendAudit);
  });
  return getOrder(tenantId, orderId);
}

async function saveOrderInTransaction(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  input: OrderMutationInput,
  auditMetadata: RequestAuditMetadata,
  appendAudit: RequestAuditAppender
): Promise<void> {
    const order = await transaction.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true, invoice: true },
    });
    if (order === null) throw new NotFoundError();
    const hasFinancialChange =
      input.customerId !== undefined ||
      input.orderDate !== undefined ||
      input.notes !== undefined ||
      input.items !== undefined;
    const invoiceIsFinal = order.invoice !== null && order.invoice.status !== invoiceStatus.DRAFT;
    if (invoiceIsFinal && hasFinancialChange) {
      throw new ConflictError(
        "ORDER_FINALIZED",
        "Orders with finalized invoices cannot be changed"
      );
    }
    if (input.customerId !== undefined && input.customerId !== order.customerId) {
      throw new DomainInvariantError(
        "ORDER_CUSTOMER_IMMUTABLE",
        "Changing an order customer requires a new order"
      );
    }

    const itemsById = new Map(order.items.map((item) => [item.id, item]));
    for (const itemUpdate of input.items ?? []) {
      const item = itemsById.get(itemUpdate.id);
      if (!item) {
        throw new NotFoundError(
          "ORDER_ITEM_NOT_FOUND",
          `Order item ${itemUpdate.id} was not found on this order`
        );
      }
      if (item.pricingSnapshot === null) {
        throw new PreconditionError(
          "ORDER_PRICING_BACKFILL_REQUIRED",
          `Order item ${item.id} must be backfilled before its quantity can change`
        );
      }
      const repriced = repriceOrderPricingSnapshot(item.pricingSnapshot, itemUpdate.quantity);
      await transaction.orderItem.update({
        where: { id: item.id },
        data: {
          quantity: legacyNumber(repriced.quantityDecimal, quantityFormat),
          quantityDecimal: repriced.quantityDecimal,
          unitPrice: legacyNumber(repriced.effectiveUnitPriceDecimal, moneyFormat),
          effectiveUnitPriceDecimal: repriced.effectiveUnitPriceDecimal,
          amountDecimal: repriced.amountDecimal,
        },
      });
    }

    if (input.orderDate !== undefined || input.notes !== undefined) {
      await transaction.order.update({
        // The tenant-qualified read above proves ownership inside this transaction.
        where: { id: orderId },
        data: {
          orderDate: input.orderDate === undefined ? undefined : new Date(input.orderDate),
          notes: input.notes,
        },
      });
    }
    if (input.comment !== undefined) {
      await transaction.orderComment.create({
        data: {
          orderId,
          author: input.comment.author ?? "billing-ops",
          body: input.comment.body,
        },
      });
    }
    await syncDraftInvoiceInTransaction(transaction, tenantId, orderId);
    await appendOrderAudit(transaction, auditMetadata, appendAudit, "ORDER_UPDATED", order.id);
}

/**
 * Acquires the aggregate Order version before any child write, then reads the
 * final version in the same transaction because item/comment/invoice triggers
 * may advance it further while producing the representation.
 */
export async function saveOrderConditionally(
  tenantId: string,
  orderId: string,
  input: OrderMutationInput,
  ifMatch: string | undefined,
  audit: RequestAuditMetadata,
  appendAudit: RequestAuditAppender = appendRequestAuditEvent
): Promise<VersionedOrder> {
  const auditMetadata = requireOrderAudit(tenantId, audit);
  return prisma.$transaction(async (transaction) => {
    const existing = await findTenantOrder(transaction, tenantId, orderId);
    // Resolve ownership before parsing the client condition so foreign and
    // missing resources have one indistinguishable tenant-safe response.
    if (existing === null) throw new NotFoundError();

    const currentVersion = logicalResourceVersion(existing.resourceVersion);
    const precondition = verifyResourceIfMatch(ifMatch, { kind: "order", id: existing.id }, currentVersion);
    if (!precondition.ok) throwPrecondition(precondition);
    if (precondition.version === Number.MAX_SAFE_INTEGER) {
      throw new PreconditionError("RESOURCE_VERSION_EXHAUSTED", "This resource version cannot be advanced safely");
    }

    const acquired = await transaction.order.updateMany({
      where: {
        id: existing.id,
        tenantId,
        ...(existing.resourceVersion === null
          ? { resourceVersion: null }
          : { resourceVersion: precondition.version }),
      },
      data: { resourceVersion: precondition.version + 1 },
    });
    if (acquired.count !== 1) {
      const stillVisible = await findTenantOrder(transaction, tenantId, orderId);
      if (stillVisible === null) throw new NotFoundError();
      throw new PreconditionError("ETAG_VERSION_MISMATCH", "If-Match does not match the current resource version");
    }

    await saveOrderInTransaction(transaction, tenantId, orderId, input, auditMetadata, appendAudit);
    const updated = await findTenantOrder(transaction, tenantId, orderId);
    if (updated === null) throw new NotFoundError();
    return {
      order: toOrderModel(updated),
      etag: formatResourceEtag({
        kind: "order",
        id: updated.id,
        version: logicalResourceVersion(updated.resourceVersion),
      }),
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

async function findTenantOrder(
  database: Pick<Prisma.TransactionClient, "order">,
  tenantId: string,
  orderId: string
) {
  return database.order.findFirst({
    where: { id: orderId, tenantId },
    include: orderInclude,
  });
}

async function appendOrderAudit(
  transaction: OrderAuditTransaction,
  metadata: RequestAuditMetadata,
  appendAudit: RequestAuditAppender,
  action: "ORDER_CREATED" | "ORDER_UPDATED",
  orderId: string
): Promise<void> {
  await appendAudit(auditRepository(transaction), metadata, {
    action,
    resourceKind: "ORDER",
    resourceId: orderId,
  });
}

/** Adapts Prisma's generic delegate to the narrow append-only audit boundary. */
function auditRepository(transaction: OrderAuditTransaction): AuditEventRepository {
  return {
    auditEvent: {
      create: async ({ data }) => transaction.auditEvent.create({ data }),
    },
  };
}

/** A caller may not attribute a tenant-scoped order mutation to another tenant. */
function requireOrderAudit(tenantId: string, audit: RequestAuditMetadata): RequestAuditMetadata {
  const parsedAudit = RequestAuditMetadataSchema.parse(audit);
  if (parsedAudit.tenantId !== tenantId) {
    throw new DomainInvariantError(
      "AUDIT_TENANT_MISMATCH",
      "Audit metadata must belong to the mutated order tenant"
    );
  }
  return parsedAudit;
}
