import { prisma } from "../db";
import { parseRateTiers } from "../domain/rateTier";
import { InvoiceModel, toInvoiceModel } from "../models/invoice";
import { toTransmissionModel, TransmissionModel } from "../models/transmission";
import { renderInvoicePdf } from "../services/pdf";
import {
  attachDocument,
  checkPortalJob,
  createPortalJob,
  sendEmail,
  submitToClearinghouse,
} from "../services/transmission";

const invoiceInclude = {
  customer: true,
  order: true,
  lines: true,
  applications: { include: { payment: true }, orderBy: { appliedAt: "asc" } },
  transmissions: { orderBy: { createdAt: "asc" } },
} as const;

export async function listInvoices(): Promise<InvoiceModel[]> {
  const rows = await prisma.invoice.findMany({
    include: invoiceInclude,
    orderBy: { issueDate: "desc" },
  });
  return rows.map(toInvoiceModel);
}

export async function getInvoice(invoiceId: string): Promise<InvoiceModel> {
  const row = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: invoiceInclude,
  });
  return toInvoiceModel(row);
}

async function nextInvoiceNumber(): Promise<string> {
  const count = await prisma.invoice.count();
  return `INV-${String(count + 1).padStart(5, "0")}`;
}

export async function createInvoiceForOrder(orderId: string): Promise<InvoiceModel> {
  // Generating an invoice re-rates the order so it bills at current prices.
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const combos = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: order.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const orderProductIds = order.items.map((i) => i.productId);
  const lines: { description: string; quantity: number; unitPrice: number; amount: number }[] =
    [];
  for (const item of order.items) {
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
    lines.push({
      description: `${item.product.name} @ ${item.product.unit}`,
      quantity: item.quantity,
      unitPrice,
      amount: unitPrice * item.quantity,
    });
  }
  const total = lines.reduce((sum, line) => sum + line.amount, 0);

  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const invoice = await prisma.invoice.create({
    data: {
      number: await nextInvoiceNumber(),
      customerId: order.customerId,
      orderId,
      issueDate,
      dueDate,
      total,
      lines: { create: lines },
    },
  });
  await prisma.order.update({ where: { id: orderId }, data: { status: "INVOICED" } });
  return getInvoice(invoice.id);
}

// Update the invoice's dates.
export async function updateInvoice(
  invoiceId: string,
  input: { issueDate?: string; dueDate?: string }
): Promise<InvoiceModel> {
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      issueDate: input.issueDate !== undefined ? new Date(input.issueDate) : undefined,
      dueDate: input.dueDate !== undefined ? new Date(input.dueDate) : undefined,
    },
  });
  return getInvoice(invoiceId);
}

// Draft invoices follow their order: whenever the order changes, the draft is
// rebuilt from current prices. Posted invoices are left alone.
export async function syncDraftInvoice(orderId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({ where: { orderId } });
  if (!invoice || invoice.status !== "DRAFT") return;

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const bundles = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: order.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const productIds = order.items.map((line) => line.productId);
  const freshLines = order.items.map((line) => {
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
    for (const bundle of bundles) {
      const bundleProductIds = bundle.products.map((p) => p.id);
      if (
        bundleProductIds.every((pid) => productIds.includes(pid)) &&
        bundleProductIds.includes(line.productId)
      ) {
        price = price * (1 - bundle.percentOff / 100);
      }
    }
    return {
      description: `${line.product.name} @ ${line.product.unit}`,
      quantity: line.quantity,
      unitPrice: price,
      amount: price * line.quantity,
    };
  });

  await prisma.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } });
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      total: freshLines.reduce((sum, line) => sum + line.amount, 0),
      lines: { create: freshLines },
    },
  });
}

// Posting finalizes the invoice: prices are computed one last time and the
// invoice is stamped POSTED.
export async function postInvoice(invoiceId: string): Promise<InvoiceModel> {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: invoice.orderId },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const combos = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: order.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const idsInOrder = order.items.map((item) => item.productId);
  const finalLines = order.items.map((item) => {
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
      description: `${item.product.name} @ ${item.product.unit}`,
      quantity: item.quantity,
      unitPrice,
      amount: unitPrice * item.quantity,
    };
  });

  await prisma.invoiceLine.deleteMany({ where: { invoiceId } });
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "POSTED",
      postedAt: new Date(),
      total: finalLines.reduce((sum, line) => sum + line.amount, 0),
      lines: { create: finalLines },
    },
  });
  return getInvoice(invoiceId);
}

export async function sendInvoice(invoiceId: string, method: string): Promise<InvoiceModel> {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { customer: true, lines: true },
  });

  let result: { status: string; detail: string; externalJobId?: string };
  if (method === "EMAIL") {
    result = sendEmail(invoice.customer.email, invoice.number);
  } else if (method === "PORTAL") {
    result = createPortalJob(invoice.customer.portalAccount ?? "unknown", invoice.number);
  } else if (method === "API") {
    result = submitToClearinghouse(invoice.customer.clearinghouseId ?? "unknown", invoice.number);
  } else {
    throw new Error(`Unknown transmission method: ${method}`);
  }

  const transmission = await prisma.transmission.create({
    data: {
      invoiceId,
      method,
      status: result.status,
      externalJobId: result.externalJobId ?? null,
      detail: result.detail,
    },
  });
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "SENT" } });

  // Generate the invoice PDF and hand it off for delivery.
  const pdf = renderInvoicePdf({
    number: invoice.number,
    customerName: invoice.customer.name,
    billingAddress: invoice.customer.billingAddress,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    total: invoice.total,
    lines: invoice.lines,
  });
  attachDocument(method, transmission.externalJobId ?? transmission.id, pdf);

  return getInvoice(invoiceId);
}

// Poll the external portal service and refresh the job status.
export async function refreshTransmission(transmissionId: string): Promise<TransmissionModel> {
  const transmission = await prisma.transmission.findUniqueOrThrow({
    where: { id: transmissionId },
  });
  if (transmission.method === "PORTAL" && transmission.status !== "DELIVERED") {
    const status = checkPortalJob(transmission.createdAt);
    const updated = await prisma.transmission.update({
      where: { id: transmissionId },
      data: { status },
    });
    return toTransmissionModel(updated);
  }
  return toTransmissionModel(transmission);
}
