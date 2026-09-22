import { prisma } from "../src/db";
import { parseRateTiers } from "../src/domain/rateTier";

async function wipe() {
  await prisma.transmission.deleteMany();
  await prisma.paymentApplication.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.orderComment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.comboDiscount.deleteMany();
  await prisma.rate.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
}

async function createOrder(
  id: string,
  customerId: string,
  orderDate: string,
  status: string,
  items: { productId: string; quantity: number }[],
  shipTo?: string
) {
  const count = await prisma.order.count();
  await prisma.order.create({
    data: {
      id,
      reference: `SO-${String(count + 1).padStart(4, "0")}`,
      customerId,
      orderDate: new Date(orderDate),
      status,
      shipTo,
    },
  });
  for (const item of items) {
    const rate = await prisma.rate.findUniqueOrThrow({
      where: { customerId_productId: { customerId, productId: item.productId } },
    });
    await prisma.orderItem.create({
      data: {
        orderId: id,
        productId: item.productId,
        rateId: rate.id,
        quantity: item.quantity,
        unitPrice: rate.unitPrice,
      },
    });
  }
  // Store computed prices on the items.
  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const combos = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId }, { customerId: null }] },
    include: { products: true },
  });
  const orderProductIds = order.items.map((i) => i.productId);
  for (const item of order.items) {
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
        comboProductIds.every((pid) => orderProductIds.includes(pid)) &&
        comboProductIds.includes(item.productId)
      ) {
        unitPrice = unitPrice * (1 - combo.percentOff / 100);
      }
    }
    await prisma.orderItem.update({ where: { id: item.id }, data: { unitPrice } });
  }
}

async function createInvoice(
  id: string,
  number: string,
  orderId: string,
  issueDate: string,
  status: string,
  amountPaid = 0
) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { product: true, rate: true } } },
  });
  const bundles = await prisma.comboDiscount.findMany({
    where: { OR: [{ customerId: order.customerId }, { customerId: null }] },
    include: { products: true },
  });
  const productIds = order.items.map((line) => line.productId);
  const lines = order.items.map((line) => {
    let price = line.rate.unitPrice;
    const tierList = parseRateTiers(line.rate.tiers);
    if (tierList.length > 0 && line.quantity > 0) {
      let charged = 0;
      let from = 0;
      for (const band of tierList.toSorted(
        (a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity)
      )) {
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
  const total = lines.reduce((sum, line) => sum + line.amount, 0);

  const issue = new Date(issueDate);
  const posted = status !== "DRAFT";
  await prisma.invoice.create({
    data: {
      id,
      number,
      customerId: order.customerId,
      orderId,
      status,
      issueDate: issue,
      dueDate: new Date(issue.getTime() + 30 * 24 * 60 * 60 * 1000),
      total,
      amountPaid: status === "PAID" ? total : amountPaid,
      postedAt: posted ? new Date(issue.getTime() + 2 * 24 * 60 * 60 * 1000) : null,
      lines: { create: lines },
    },
  });
  return total;
}

async function main() {
  await wipe();

  await prisma.customer.createMany({
    data: [
      {
        id: "cust_acme",
        name: "Acme Logistics",
        email: "ap@acmelogistics.com",
        billingAddress: "1 Freight Way, Reno, NV",
        portalAccount: "ACME-AP-291",
        clearinghouseId: "TP-ACME-01",
      },
      {
        id: "cust_bluebird",
        name: "Bluebird Media",
        email: "billing@bluebird.media",
        billingAddress: "88 Aviary Ave, Austin, TX",
        clearinghouseId: "TP-BLUE-77",
      },
      {
        id: "cust_cascade",
        name: "Cascade Manufacturing",
        email: "payables@cascademfg.com",
        billingAddress: "400 Mill Rd, Tacoma, WA",
        portalAccount: "CASC-PORTAL-8",
      },
    ],
  });

  await prisma.product.createMany({
    data: [
      { id: "prod_seat", sku: "SEAT-STD", name: "Standard Seat License", unit: "seat/month", listPrice: 45 },
      { id: "prod_storage", sku: "STG-GB", name: "Object Storage", unit: "GB/month", listPrice: 0.12 },
      { id: "prod_api", sku: "API-1K", name: "API Calls", unit: "1k calls", listPrice: 0.9 },
      { id: "prod_support", sku: "SUP-PREM", name: "Premium Support", unit: "contract/month", listPrice: 1200 },
      { id: "prod_device", sku: "DEV-TRK", name: "Fleet Tracker Device", unit: "device", listPrice: 210 },
    ],
  });

  // Tiers are quantity intervals: units inside each interval bill at its price,
  // with the interval charge clamped between floor and ceiling.
  await prisma.rate.createMany({
    data: [
      // Acme
      {
        id: "rate_acme_seat", customerId: "cust_acme", productId: "prod_seat", unitPrice: 39,
        tiers: [
          { upTo: 100, unitPrice: 39 },
          { upTo: 250, unitPrice: 34, floor: 500 },
          { upTo: null, unitPrice: 29.5, ceiling: 12000 },
        ],
        effectiveDate: new Date("2025-01-01"),
      },
      {
        id: "rate_acme_device", customerId: "cust_acme", productId: "prod_device", unitPrice: 185,
        tiers: [
          { upTo: 50, unitPrice: 185 },
          { upTo: 200, unitPrice: 172, floor: 2000 },
          { upTo: null, unitPrice: 159, ceiling: 40000 },
        ],
        effectiveDate: new Date("2025-01-01"),
      },
      {
        id: "rate_acme_support", customerId: "cust_acme", productId: "prod_support", unitPrice: 950,
        effectiveDate: new Date("2025-01-01"),
      },
      {
        id: "rate_acme_api", customerId: "cust_acme", productId: "prod_api", unitPrice: 0.85,
        tiers: [
          { upTo: 500, unitPrice: 0.85, floor: 50 },
          { upTo: null, unitPrice: 0.72 },
        ],
        effectiveDate: new Date("2025-01-01"),
      },
      // Bluebird
      {
        id: "rate_blue_storage", customerId: "cust_bluebird", productId: "prod_storage", unitPrice: 0.1,
        tiers: [
          { upTo: 5000, unitPrice: 0.1, floor: 150 },
          { upTo: 20000, unitPrice: 0.085 },
          { upTo: null, unitPrice: 0.07, ceiling: 2500 },
        ],
        effectiveDate: new Date("2025-03-01"),
      },
      {
        id: "rate_blue_api", customerId: "cust_bluebird", productId: "prod_api", unitPrice: 0.8,
        tiers: [
          { upTo: 1000, unitPrice: 0.8 },
          { upTo: null, unitPrice: 0.66 },
        ],
        effectiveDate: new Date("2025-03-01"),
      },
      {
        id: "rate_blue_seat", customerId: "cust_bluebird", productId: "prod_seat", unitPrice: 42,
        effectiveDate: new Date("2025-03-01"),
      },
      // Cascade
      {
        id: "rate_casc_seat", customerId: "cust_cascade", productId: "prod_seat", unitPrice: 41,
        effectiveDate: new Date("2025-06-01"),
      },
      {
        id: "rate_casc_device", customerId: "cust_cascade", productId: "prod_device", unitPrice: 199,
        tiers: [
          { upTo: 100, unitPrice: 199 },
          { upTo: null, unitPrice: 180, floor: 1000 },
        ],
        effectiveDate: new Date("2025-06-01"),
      },
      {
        id: "rate_casc_support", customerId: "cust_cascade", productId: "prod_support", unitPrice: 1100,
        effectiveDate: new Date("2025-06-01"),
      },
    ],
  });

  await prisma.comboDiscount.create({
    data: {
      id: "combo_acme_platform", customerId: "cust_acme", name: "Platform Bundle", percentOff: 10,
      products: { connect: [{ id: "prod_seat" }, { id: "prod_support" }] },
    },
  });
  await prisma.comboDiscount.create({
    data: {
      id: "combo_blue_data", customerId: "cust_bluebird", name: "Data Bundle", percentOff: 12,
      products: { connect: [{ id: "prod_storage" }, { id: "prod_api" }] },
    },
  });
  await prisma.comboDiscount.create({
    data: {
      id: "combo_casc_fleet", customerId: "cust_cascade", name: "Fleet Bundle", percentOff: 7.5,
      products: { connect: [{ id: "prod_seat" }, { id: "prod_device" }] },
    },
  });
  // Global: applies to every customer.
  await prisma.comboDiscount.create({
    data: {
      id: "combo_global_devkit", customerId: null, name: "Seats + API Promo", percentOff: 5,
      products: { connect: [{ id: "prod_seat" }, { id: "prod_api" }] },
    },
  });

  await createOrder("ord_1", "cust_acme", "2025-05-12", "INVOICED", [
    { productId: "prod_seat", quantity: 120 },
    { productId: "prod_support", quantity: 1 },
  ], "Acme Logistics HQ, 1 Freight Way, Reno, NV");
  await createOrder("ord_2", "cust_bluebird", "2025-07-03", "INVOICED", [
    { productId: "prod_storage", quantity: 8000 },
    { productId: "prod_api", quantity: 1500 },
  ], "Bluebird Media, 88 Aviary Ave, Austin, TX");
  await createOrder("ord_3", "cust_acme", "2025-09-20", "INVOICED", [
    { productId: "prod_device", quantity: 60 },
    { productId: "prod_seat", quantity: 120 },
    { productId: "prod_support", quantity: 1 },
  ], "Acme Depot 12, 340 Yard St, Sparks, NV");
  await createOrder("ord_4", "cust_cascade", "2025-11-08", "INVOICED", [
    { productId: "prod_seat", quantity: 35 },
    { productId: "prod_device", quantity: 110 },
  ], "Cascade Plant 2, 410 Mill Rd, Tacoma, WA");
  await createOrder("ord_5", "cust_bluebird", "2026-02-14", "INVOICED", [
    { productId: "prod_storage", quantity: 25000 },
    { productId: "prod_api", quantity: 900 },
  ], "Bluebird Media, 88 Aviary Ave, Austin, TX");
  await createOrder("ord_6", "cust_cascade", "2026-06-30", "INVOICED", [
    { productId: "prod_support", quantity: 1 },
    { productId: "prod_seat", quantity: 35 },
  ], "Cascade Plant 2, 410 Mill Rd, Tacoma, WA");
  await createOrder("ord_7", "cust_acme", "2026-07-22", "OPEN", [
    { productId: "prod_seat", quantity: 140 },
    { productId: "prod_api", quantity: 600 },
  ], "Acme Logistics HQ, 1 Freight Way, Reno, NV");
  await createOrder("ord_8", "cust_bluebird", "2026-08-05", "INVOICED", [
    { productId: "prod_seat", quantity: 6 },
  ], "Bluebird Media, 88 Aviary Ave, Austin, TX");

  await prisma.orderComment.createMany({
    data: [
      { id: "cmt_1", orderId: "ord_3", author: "d.kim", body: "Confirmed tracker count with Acme ops before shipping.", createdAt: new Date("2025-09-22T16:04:00Z") },
      { id: "cmt_2", orderId: "ord_3", author: "a.reyes", body: "Customer asked for NET-45 — declined, standard NET-30 applies.", createdAt: new Date("2025-09-28T19:41:00Z") },
      { id: "cmt_3", orderId: "ord_4", author: "d.kim", body: "Devices shipped in two batches; second batch landed Nov 18.", createdAt: new Date("2025-11-20T15:12:00Z") },
      { id: "cmt_4", orderId: "ord_6", author: "a.reyes", body: "Holding invoice until the support contract is countersigned.", createdAt: new Date("2026-07-02T17:30:00Z") },
    ],
  });

  await createInvoice("inv_1", "INV-00001", "ord_1", "2025-05-15", "PAID");
  await createInvoice("inv_2", "INV-00002", "ord_2", "2025-07-10", "PAID");
  await createInvoice("inv_3", "INV-00003", "ord_3", "2025-10-01", "SENT", 5000);
  await createInvoice("inv_4", "INV-00004", "ord_4", "2026-01-12", "POSTED");
  await createInvoice("inv_5", "INV-00005", "ord_5", "2026-03-02", "SENT", 1000);
  await createInvoice("inv_6", "INV-00006", "ord_6", "2026-07-05", "DRAFT");
  await createInvoice("inv_7", "INV-00007", "ord_8", "2026-08-10", "DRAFT");

  const inv1 = await prisma.invoice.findUniqueOrThrow({ where: { id: "inv_1" } });
  const inv2 = await prisma.invoice.findUniqueOrThrow({ where: { id: "inv_2" } });
  await prisma.payment.create({
    data: {
      id: "pay_1", customerId: "cust_acme", amount: inv1.total,
      receivedAt: new Date("2025-06-10"), reference: "ACH 88231",
      applications: { create: [{ id: "app_1", invoiceId: "inv_1", amount: inv1.total, appliedAt: new Date("2025-06-10") }] },
    },
  });
  await prisma.payment.create({
    data: {
      id: "pay_2", customerId: "cust_bluebird", amount: inv2.total,
      receivedAt: new Date("2025-08-02"), reference: "CHK 1077",
      applications: { create: [{ id: "app_2", invoiceId: "inv_2", amount: inv2.total, appliedAt: new Date("2025-08-02") }] },
    },
  });
  await prisma.payment.create({
    data: {
      id: "pay_3", customerId: "cust_acme", amount: 5000,
      receivedAt: new Date("2025-10-28"), reference: "ACH 90112",
      applications: { create: [{ id: "app_3", invoiceId: "inv_3", amount: 5000, appliedAt: new Date("2025-10-28") }] },
    },
  });
  // Received 2,500 but only 1,000 applied so far — 1,500 sits as unapplied cash.
  await prisma.payment.create({
    data: {
      id: "pay_4", customerId: "cust_bluebird", amount: 2500,
      receivedAt: new Date("2026-03-20"), reference: "WIRE 5541",
      applications: { create: [{ id: "app_4", invoiceId: "inv_5", amount: 1000, appliedAt: new Date("2026-03-22") }] },
    },
  });

  await prisma.transmission.createMany({
    data: [
      { id: "tx_1", invoiceId: "inv_3", method: "EMAIL", status: "SENT", detail: "Emailed to ap@acmelogistics.com" },
      { id: "tx_2", invoiceId: "inv_5", method: "PORTAL", status: "DELIVERED", externalJobId: "pj_seed0001", detail: "Upload queued for portal account BLUE-PORTAL" },
    ],
  });

  const counts = {
    customers: await prisma.customer.count(),
    products: await prisma.product.count(),
    rates: await prisma.rate.count(),
    orders: await prisma.order.count(),
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
  };
  console.log("seeded:", counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
