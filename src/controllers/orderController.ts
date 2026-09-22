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
  ConflictError,
  DomainInvariantError,
  NotFoundError,
  PreconditionError,
} from "../errors";
import { OrderModel, toOrderModel } from "../models/order";
import { syncDraftInvoiceInTransaction } from "./invoiceController";

const DEFAULT_BILLING_CURRENCY = "USD";
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

export async function listOrders(): Promise<OrderModel[]> {
  const rows = await prisma.order.findMany({
    include: orderInclude,
    orderBy: { orderDate: "desc" },
  });
  return rows.map(toOrderModel);
}

export async function getOrder(orderId: string): Promise<OrderModel> {
  const row = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  });
  return toOrderModel(row);
}

type PricingTransaction = Prisma.TransactionClient;

async function capturedOrderLines(
  transaction: PricingTransaction,
  input: {
    customerId: string;
    items: readonly { productId: string; quantity: string | number }[];
    capturedAt: Date;
  }
): Promise<CapturedOrderPricing[]> {
  await transaction.customer.findUniqueOrThrow({ where: { id: input.customerId } });
  const productIds = input.items.map((item) => item.productId);
  const products = await transaction.product.findMany({ where: { id: { in: productIds } } });
  if (products.length !== productIds.length) {
    const found = new Set(products.map((product) => product.id));
    const missing = productIds.find((productId) => !found.has(productId));
    throw new NotFoundError(
      "PRODUCT_NOT_FOUND",
      `Product ${missing ?? "unknown"} was not found`
    );
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const existingRates = await transaction.rate.findMany({
    where: { customerId: input.customerId, productId: { in: productIds } },
  });
  const ratesByProductId = new Map(existingRates.map((rate) => [rate.productId, rate]));

  for (const productId of productIds) {
    if (ratesByProductId.has(productId)) continue;
    const product = productsById.get(productId);
    if (!product) {
      throw new NotFoundError("PRODUCT_NOT_FOUND", `Product ${productId} was not found`);
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
    where: { OR: [{ customerId: input.customerId }, { customerId: null }] },
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

export async function createOrder(input: {
  customerId: string;
  items: { productId: string; quantity: string | number }[];
  notes?: string;
}): Promise<OrderModel> {
  const orderId = randomUUID();
  await prisma.$transaction(async (transaction) => {
    const lines = await capturedOrderLines(transaction, {
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
        reference: orderReference(orderId),
        customerId: input.customerId,
        notes: input.notes,
        currencyCode: lines[0]?.currencyCode,
      },
    });
    await transaction.orderItem.createMany({
      data: lines.map((line) => orderItemCreateData(orderId, line)),
    });
  });
  return getOrder(orderId);
}

// Order terms are captured once. Quantity changes recalculate from those terms;
// changing the customer would require an explicit re-contracting workflow.
export async function saveOrder(
  orderId: string,
  input: {
    customerId?: string;
    orderDate?: string;
    notes?: string;
    items?: { id: string; quantity: string | number }[];
    comment?: { author?: string; body: string };
  }
): Promise<OrderModel> {
  await prisma.$transaction(async (transaction) => {
    const order = await transaction.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, invoice: true },
    });
    const hasFinancialChange =
      input.customerId !== undefined ||
      input.orderDate !== undefined ||
      input.notes !== undefined ||
      input.items !== undefined;
    const invoiceIsFinal = order.invoice !== null && order.invoice.status !== "DRAFT";
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
    await syncDraftInvoiceInTransaction(transaction, orderId);
  });
  return getOrder(orderId);
}
