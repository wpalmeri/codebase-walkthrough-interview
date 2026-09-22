import type { Invoice, Order, OrderComment, OrderItem, Product } from "@prisma/client";
import { OrderSchema, type Order as ContractOrder } from "@meridian/contracts";
import {
  addDecimal,
  canonicalMoney,
  decimalOrLegacy,
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
} from "../domain/money";
import { productSubtotal } from "../domain/pricing";

export type OrderModel = ContractOrder;

type OrderRow = Order & {
  customer?: { name: string; email: string; billingAddress: string | null };
  items?: (OrderItem & { product?: Product })[];
  invoice?: Invoice | null;
  comments?: OrderComment[];
};

export function toOrderModel(row: OrderRow): OrderModel {
  const items = (row.items ?? []).map((item) => {
    const quantityDecimal = decimalOrLegacy(
      { decimal: item.quantityDecimal, legacy: item.quantity },
      { scale: QUANTITY_SCALE, precision: QUANTITY_PRECISION, field: "order item quantity" }
    );
    const effectiveUnitPriceDecimal = decimalOrLegacy(
      { decimal: item.effectiveUnitPriceDecimal, legacy: item.unitPrice },
      { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "order item unit price" }
    );
    const baseUnitPriceDecimal = decimalOrLegacy(
      { decimal: item.baseUnitPriceDecimal, legacy: item.unitPrice },
      { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "order item base unit price" }
    );
    const amountDecimal = canonicalMoney(
      productSubtotal(effectiveUnitPriceDecimal, quantityDecimal),
      "order item amount"
    );
    return {
      id: item.id,
      productId: item.productId,
      productSku: item.productSkuSnapshot ?? item.product?.sku,
      productName: item.productNameSnapshot ?? item.product?.name,
      rateId: item.rateId,
      quantity: Number(quantityDecimal),
      unitPrice: Number(effectiveUnitPriceDecimal),
      amount: Number(amountDecimal),
      quantityDecimal,
      baseUnitPriceDecimal,
      effectiveUnitPriceDecimal,
      amountDecimal,
    };
  });
  const totalDecimal = items.reduce(
    (sum, item) =>
      addDecimal(sum, item.amountDecimal, {
        scale: MONEY_SCALE,
        precision: MONEY_PRECISION,
        field: "order total",
      }),
    "0.0000"
  );
  return OrderSchema.parse({
    id: row.id,
    reference: row.reference,
    customerId: row.customerId,
    customerName: row.customer?.name,
    customerEmail: row.customer?.email,
    billingAddress: row.customer?.billingAddress,
    orderDate: row.orderDate.toISOString(),
    status: row.status,
    shipTo: row.shipTo,
    notes: row.notes,
    currencyCode: row.currencyCode ?? undefined,
    items,
    comments: (row.comments ?? []).map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
    })),
    total: Number(totalDecimal),
    totalDecimal,
    invoiceId: row.invoice?.id ?? null,
    invoiceNumber: row.invoice?.number ?? null,
    invoiceStatus: row.invoice?.status ?? null,
  });
}
