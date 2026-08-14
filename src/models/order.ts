import type { Invoice, Order, OrderComment, OrderItem, Product } from "@prisma/client";

export interface OrderItemModel {
  id: string;
  productId: string;
  productSku?: string;
  productName?: string;
  rateId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface OrderCommentModel {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface OrderModel {
  id: string;
  reference: string | null;
  customerId: string;
  customerName?: string;
  customerEmail?: string;
  billingAddress?: string | null;
  orderDate: string;
  status: string;
  shipTo: string | null;
  notes: string | null;
  items: OrderItemModel[];
  comments: OrderCommentModel[];
  total: number;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
}

type OrderRow = Order & {
  customer?: { name: string; email: string; billingAddress: string | null };
  items?: (OrderItem & { product?: Product })[];
  invoice?: Invoice | null;
  comments?: OrderComment[];
};

export function toOrderModel(row: OrderRow): OrderModel {
  const items = (row.items ?? []).map((item) => ({
    id: item.id,
    productId: item.productId,
    productSku: item.product?.sku,
    productName: item.product?.name,
    rateId: item.rateId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: item.unitPrice * item.quantity,
  }));
  return {
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
    items,
    comments: (row.comments ?? []).map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
    })),
    total: items.reduce((sum, item) => sum + item.amount, 0),
    invoiceId: row.invoice?.id ?? null,
    invoiceNumber: row.invoice?.number ?? null,
    invoiceStatus: row.invoice?.status ?? null,
  };
}
