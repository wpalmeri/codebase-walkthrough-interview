import { prisma } from "../db";
import { parseRateTiers } from "../domain/rateTier";
import { OrderModel, toOrderModel } from "../models/order";
import { syncDraftInvoice } from "./invoiceController";

const orderInclude = {
  customer: true,
  items: { include: { product: true, rate: true } },
  invoice: true,
  comments: { orderBy: { createdAt: "asc" } },
} as const;

// Order totals are never stored; they are recalculated from the customer's
// current rates every time orders are read.
export async function listOrders(): Promise<OrderModel[]> {
  const rows = await prisma.order.findMany({
    include: orderInclude,
    orderBy: { orderDate: "desc" },
  });
  const allCombos = await prisma.comboDiscount.findMany({ include: { products: true } });

  return rows.map((row) => {
    const model = toOrderModel(row);
    const combos = allCombos.filter(
      (combo) => combo.customerId === row.customerId || combo.customerId === null
    );
    const productIds = row.items.map((item) => item.productId);
    let orderTotal = 0;
    for (const item of row.items) {
      const schedule = parseRateTiers(item.rate.tiers);
      let charge: number;
      if (schedule.length === 0 || item.quantity <= 0) {
        charge = item.quantity * item.rate.unitPrice;
      } else {
        charge = 0;
        let covered = 0;
        for (const band of schedule.toSorted(
          (a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity)
        )) {
          const limit = band.upTo ?? Infinity;
          const unitsHere = Math.min(item.quantity, limit) - covered;
          if (unitsHere > 0) {
            let bandCharge = unitsHere * band.unitPrice;
            if (band.floor != null && bandCharge < band.floor) bandCharge = band.floor;
            if (band.ceiling != null && bandCharge > band.ceiling) bandCharge = band.ceiling;
            charge += bandCharge;
          }
          covered = limit;
          if (limit >= item.quantity) break;
        }
      }
      for (const combo of combos) {
        const comboProductIds = combo.products.map((p) => p.id);
        if (
          comboProductIds.every((pid) => productIds.includes(pid)) &&
          comboProductIds.includes(item.productId)
        ) {
          charge = charge * (1 - combo.percentOff / 100);
        }
      }
      orderTotal += charge;
    }
    model.total = orderTotal;
    return model;
  });
}

export async function getOrder(orderId: string): Promise<OrderModel> {
  const row = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  });
  const model = toOrderModel(row);

  // Price the order fresh for the detail view; nothing is stored on the order.
  const combos = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: row.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const idsInOrder = row.items.map((item) => item.productId);
  model.items = row.items.map((item, index) => {
    let unitPrice = item.rate.unitPrice;
    const tiers = parseRateTiers(item.rate.tiers);
    if (tiers.length > 0 && item.quantity > 0) {
      let total = 0;
      let lower = 0;
      for (const interval of tiers.toSorted(
        (a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity)
      )) {
        const upper = interval.upTo ?? Infinity;
        const units = Math.min(item.quantity, upper) - lower;
        if (units > 0) {
          let charge = units * interval.unitPrice;
          if (interval.floor != null && charge < interval.floor) charge = interval.floor;
          if (interval.ceiling != null && charge > interval.ceiling) charge = interval.ceiling;
          total += charge;
        }
        lower = upper;
        if (upper >= item.quantity) break;
      }
      unitPrice = total / item.quantity;
    }
    for (const combo of combos) {
      const comboProductIds = combo.products.map((p) => p.id);
      if (
        comboProductIds.every((pid) => idsInOrder.includes(pid)) &&
        comboProductIds.includes(item.productId)
      ) {
        unitPrice = unitPrice * (1 - combo.percentOff / 100);
      }
    }
    return {
      ...model.items[index],
      unitPrice,
      amount: unitPrice * item.quantity,
    };
  });
  model.total = model.items.reduce((sum, item) => sum + item.amount, 0);
  return model;
}

export async function createOrder(input: {
  customerId: string;
  items: { productId: string; quantity: number }[];
  notes?: string;
}): Promise<OrderModel> {
  const count = await prisma.order.count();
  const order = await prisma.order.create({
    data: {
      reference: `SO-${String(count + 1).padStart(4, "0")}`,
      customerId: input.customerId,
      notes: input.notes,
    },
  });

  for (const item of input.items) {
    // Find the customer's rate for this product; set one up from list price if missing.
    let rate = await prisma.rate.findUnique({
      where: { customerId_productId: { customerId: input.customerId, productId: item.productId } },
    });
    if (!rate) {
      const product = await prisma.product.findUniqueOrThrow({ where: { id: item.productId } });
      rate = await prisma.rate.create({
        data: {
          customerId: input.customerId,
          productId: item.productId,
          unitPrice: product.listPrice,
        },
      });
    }
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: item.productId,
        rateId: rate.id,
        quantity: item.quantity,
        unitPrice: rate.unitPrice,
      },
    });
  }

  // Price the new order from the customer's rates, bundles, and discount.
  const created = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const combos = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: created.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const orderProductIds = created.items.map((i) => i.productId);
  for (const item of created.items) {
    let unitPrice = item.rate.unitPrice;
    const tiers = parseRateTiers(item.rate.tiers);
    if (tiers.length > 0 && item.quantity > 0) {
      // Blend the interval charges into one per-unit price.
      let total = 0;
      let lower = 0;
      for (const interval of tiers.toSorted(
        (a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity)
      )) {
        const upper = interval.upTo ?? Infinity;
        const units = Math.min(item.quantity, upper) - lower;
        if (units > 0) {
          let charge = units * interval.unitPrice;
          if (interval.floor != null && charge < interval.floor) charge = interval.floor;
          if (interval.ceiling != null && charge > interval.ceiling) charge = interval.ceiling;
          total += charge;
        }
        lower = upper;
        if (upper >= item.quantity) break;
      }
      unitPrice = total / item.quantity;
    }
    for (const combo of combos) {
      const comboProductIds = combo.products.map((p) => p.id);
      if (
        comboProductIds.every((pid) => orderProductIds.includes(pid)) &&
        comboProductIds.includes(item.productId)
      ) {
        unitPrice = unitPrice * (1 - combo.percentOff / 100);
      }
    }
    await prisma.orderItem.update({ where: { id: item.id }, data: { unitPrice } });
  }

  return getOrder(order.id);
}

// Save changes to an order: customer, order date, quantities, notes, and any new
// comment come through as one payload. Saving re-rates the order and keeps its
// draft invoice in step.
export async function saveOrder(
  orderId: string,
  input: {
    customerId?: string;
    orderDate?: string;
    notes?: string;
    items?: { id: string; quantity: number }[];
    comment?: { author?: string; body: string };
  }
): Promise<OrderModel> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const data: { notes?: string; orderDate?: Date; customerId?: string } = {};
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.orderDate !== undefined) data.orderDate = new Date(input.orderDate);
  const customerChanged =
    input.customerId !== undefined && input.customerId !== order.customerId;
  if (customerChanged) data.customerId = input.customerId;
  if (Object.keys(data).length > 0) {
    await prisma.order.update({ where: { id: orderId }, data });
  }

  // A different customer means different pricing: point every item at the new
  // customer's rate for its product (set one up from list price if missing).
  if (customerChanged) {
    const items = await prisma.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      let rate = await prisma.rate.findUnique({
        where: {
          customerId_productId: { customerId: input.customerId!, productId: item.productId },
        },
      });
      if (!rate) {
        const product = await prisma.product.findUniqueOrThrow({
          where: { id: item.productId },
        });
        rate = await prisma.rate.create({
          data: {
            customerId: input.customerId!,
            productId: item.productId,
            unitPrice: product.listPrice,
          },
        });
      }
      await prisma.orderItem.update({ where: { id: item.id }, data: { rateId: rate.id } });
    }
    await prisma.invoice.updateMany({
      where: { orderId, status: "DRAFT" },
      data: { customerId: input.customerId! },
    });
  }

  for (const item of input.items ?? []) {
    await prisma.orderItem.update({
      where: { id: item.id },
      data: { quantity: item.quantity },
    });
  }
  if (input.comment?.body) {
    await prisma.orderComment.create({
      data: {
        orderId,
        author: input.comment.author ?? "billing-ops",
        body: input.comment.body,
      },
    });
  }

  // Re-rate the order so its prices reflect the current agreement.
  const current = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const discounts = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: current.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const productIdsOnOrder = current.items.map((line) => line.productId);
  for (const line of current.items) {
    let price = line.rate.unitPrice;
    const tierList = parseRateTiers(line.rate.tiers);
    if (tierList.length > 0 && line.quantity > 0) {
      const sorted = tierList.toSorted(
        (a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity)
      );
      let charged = 0;
      let from = 0;
      for (const band of sorted) {
        const to = band.upTo ?? Infinity;
        const unitsInBand = Math.min(line.quantity, to) - from;
        if (unitsInBand > 0) {
          let bandCharge = unitsInBand * band.unitPrice;
          if (band.floor != null && bandCharge < band.floor) bandCharge = band.floor;
          if (band.ceiling != null && bandCharge > band.ceiling) bandCharge = band.ceiling;
          charged += bandCharge;
        }
        from = to;
        if (to >= line.quantity) break;
      }
      price = charged / line.quantity;
    }
    for (const bundle of discounts) {
      const bundleProductIds = bundle.products.map((p) => p.id);
      const bundleApplies = bundleProductIds.every((pid) => productIdsOnOrder.includes(pid));
      if (bundleApplies && bundleProductIds.includes(line.productId)) {
        price = price * (1 - bundle.percentOff / 100);
      }
    }
    await prisma.orderItem.update({ where: { id: line.id }, data: { unitPrice: price } });
  }

  await syncDraftInvoice(orderId);
  return getOrder(orderId);
}
