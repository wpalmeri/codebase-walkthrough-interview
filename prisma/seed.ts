import { ExactRateTierSchema } from "@meridian/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db";
import { utcAccountingDateFromInstant } from "../src/domain/accountingPeriod";
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_SCALE,
  addDecimal,
  canonicalMoney,
  canonicalPercentage,
  canonicalQuantity,
  legacyNumber,
  type DecimalInput,
} from "../src/domain/money";
import {
  captureOrderPricing,
  exactPricingInput,
  type CapturedOrderPricing,
} from "../src/domain/orderPricing";

const CURRENCY = "USD";
const moneyFormat = { scale: MONEY_SCALE, precision: MONEY_PRECISION, field: "amount" } as const;
const quantityFormat = {
  scale: QUANTITY_SCALE,
  precision: QUANTITY_PRECISION,
  field: "quantity",
} as const;

type SeedTier = {
  upTo: string | null;
  unitPrice: string;
  floor?: string | null;
  ceiling?: string | null;
};

type SeedOrder = {
  id: string;
  customerId: string;
  orderDate: string;
  status: "OPEN" | "INVOICED";
  shipTo: string;
  items: readonly { productId: string; quantity: string }[];
};

type SeedInvoice = {
  id: string;
  number: string;
  orderId: string;
  issueDate: string;
  status: "DRAFT" | "POSTED" | "SENT" | "PAID";
  amountPaid?: string;
};

function exactTiers(tiers: readonly SeedTier[]) {
  return ExactRateTierSchema.array().parse(
    tiers.map((tier) => ({
      upTo: tier.upTo === null ? null : canonicalQuantity(tier.upTo, "tier upper bound"),
      unitPrice: canonicalMoney(tier.unitPrice, "tier unit price"),
      ...(tier.floor === undefined
        ? {}
        : { floor: tier.floor === null ? null : canonicalMoney(tier.floor, "tier floor") }),
      ...(tier.ceiling === undefined
        ? {}
        : { ceiling: tier.ceiling === null ? null : canonicalMoney(tier.ceiling, "tier ceiling") }),
    }))
  );
}

function instant(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 24 * 60 * 60 * 1000);
}

function requireMoney(value: DecimalInput | null, field: string): string {
  if (value === null) throw new Error(`${field} was unexpectedly null in seeded data`);
  return canonicalMoney(value, field);
}

function requireQuantity(value: DecimalInput | null, field: string): string {
  if (value === null) throw new Error(`${field} was unexpectedly null in seeded data`);
  return canonicalQuantity(value, field);
}

function orderItemData(captured: CapturedOrderPricing) {
  return {
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

async function requireEmptyDatabase(): Promise<void> {
  const counts = await Promise.all([
    prisma.customer.count(),
    prisma.product.count(),
    prisma.order.count(),
    prisma.invoice.count(),
    prisma.payment.count(),
    prisma.backfillCheckpoint.count(),
  ]);
  if (counts.some((count) => count !== 0)) {
    throw new Error(
      "Seed requires an empty database because finalized financial history is immutable; use `bun run db:reset` for a disposable local database"
    );
  }
}

async function createOrder(seed: SeedOrder): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const productIds = seed.items.map((item) => item.productId);
    const [products, rates, discounts] = await Promise.all([
      transaction.product.findMany({ where: { id: { in: productIds } } }),
      transaction.rate.findMany({
        where: { customerId: seed.customerId, productId: { in: productIds } },
      }),
      transaction.comboDiscount.findMany({
        where: { OR: [{ customerId: seed.customerId }, { customerId: null }] },
        include: { products: true },
      }),
    ]);
    if (products.length !== productIds.length || rates.length !== productIds.length) {
      throw new Error(`seed order ${seed.id} is missing a product or contracted rate`);
    }

    const productsById = new Map(products.map((product) => [product.id, product]));
    const ratesByProductId = new Map(rates.map((rate) => [rate.productId, rate]));
    const productIdSet = new Set(productIds);
    const capturedAt = `${seed.orderDate}T12:00:00.000Z`;
    const lines = seed.items.map((item) => {
      const product = productsById.get(item.productId);
      const rate = ratesByProductId.get(item.productId);
      if (!product || !rate || product.currencyCode !== CURRENCY || rate.currencyCode !== CURRENCY) {
        throw new Error(`seed order ${seed.id} has invalid pricing data for ${item.productId}`);
      }
      const applicableDiscounts = discounts.filter((discount) => {
        const discountProductIds = discount.products.map((candidate) => candidate.id);
        return (
          discountProductIds.includes(item.productId) &&
          discountProductIds.every((productId) => productIdSet.has(productId))
        );
      });
      const tiers = rate.tiers === null ? [] : ExactRateTierSchema.array().parse(rate.tiers);

      return captureOrderPricing(
        exactPricingInput({
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            unit: product.unit,
            currencyCode: product.currencyCode,
          },
          rate: {
            id: rate.id,
            currencyCode: rate.currencyCode,
            baseUnitPrice: requireMoney(rate.unitPriceDecimal, `rate ${rate.id} unit price`),
            tiers,
          },
          quantity: item.quantity,
          discounts: applicableDiscounts.map((discount) => ({
            id: discount.id,
            name: discount.name,
            percentOff: canonicalPercentage(
              requireMoney(discount.percentOffDecimal, `discount ${discount.id} percentage`),
              `discount ${discount.id} percentage`
            ),
          })),
          capturedAt,
        })
      );
    });

    await transaction.order.create({
      data: {
        id: seed.id,
        reference: `SO-${seed.id.replace("ord_", "").padStart(4, "0")}`,
        customerId: seed.customerId,
        orderDate: instant(seed.orderDate),
        status: seed.status,
        shipTo: seed.shipTo,
        currencyCode: CURRENCY,
      },
    });
    await transaction.orderItem.createMany({
      data: lines.map((line) => ({ orderId: seed.id, ...orderItemData(line) })),
    });
  });
}

async function createInvoice(seed: SeedInvoice): Promise<{ id: string; total: string }> {
  return prisma.$transaction(async (transaction) => {
    const order = await transaction.order.findUniqueOrThrow({
      where: { id: seed.orderId },
      include: { customer: true, items: true },
    });
    if (order.currencyCode !== CURRENCY) throw new Error(`seed order ${order.id} has no USD currency`);

    const lines = order.items.map((item) => {
      const quantityDecimal = requireQuantity(item.quantityDecimal, `order item ${item.id} quantity`);
      const unitPriceDecimal = requireMoney(
        item.effectiveUnitPriceDecimal,
        `order item ${item.id} unit price`
      );
      const amountDecimal = requireMoney(item.amountDecimal, `order item ${item.id} amount`);
      if (
        item.productSkuSnapshot === null ||
        item.productNameSnapshot === null ||
        item.productUnitSnapshot === null
      ) {
        throw new Error(`order item ${item.id} is missing a product snapshot`);
      }
      return {
        description: `${item.productNameSnapshot} @ ${item.productUnitSnapshot}`,
        quantity: legacyNumber(quantityDecimal, quantityFormat),
        unitPrice: legacyNumber(unitPriceDecimal, moneyFormat),
        amount: legacyNumber(amountDecimal, moneyFormat),
        productSkuSnapshot: item.productSkuSnapshot,
        productUnitSnapshot: item.productUnitSnapshot,
        quantityDecimal,
        unitPriceDecimal,
        amountDecimal,
      };
    });
    const totalDecimal = lines.reduce(
      (total, line) => addDecimal(total, line.amountDecimal, moneyFormat),
      canonicalMoney("0")
    );
    const amountPaidDecimal =
      seed.status === "PAID"
        ? totalDecimal
        : canonicalMoney(seed.amountPaid ?? "0", `invoice ${seed.id} amount paid`);
    const issueDate = instant(seed.issueDate);

    await transaction.invoice.create({
      data: {
        id: seed.id,
        number: seed.number,
        customerId: order.customerId,
        orderId: order.id,
        // InvoiceLine guards require immutable lines to be inserted while the
        // invoice is a draft. Advance through valid lifecycle transitions below.
        status: "DRAFT",
        issueDate,
        dueDate: addDays(issueDate, 30),
        accountingDate: utcAccountingDateFromInstant(issueDate),
        total: legacyNumber(totalDecimal, moneyFormat),
        totalDecimal,
        amountPaid: legacyNumber(amountPaidDecimal, moneyFormat),
        amountPaidDecimal,
        customerNameSnapshot: order.customer.name,
        customerEmailSnapshot: order.customer.email,
        billingAddressSnapshot: order.customer.billingAddress,
        postedAt: null,
        currencyCode: CURRENCY,
        lines: { create: lines },
      },
    });
    if (seed.status !== "DRAFT") {
      await transaction.invoice.update({
        where: { id: seed.id },
        data: { status: "POSTED", postedAt: addDays(issueDate, 2) },
      });
    }
    if (seed.status === "SENT" || seed.status === "PAID") {
      await transaction.invoice.update({ where: { id: seed.id }, data: { status: seed.status } });
    }
    return { id: seed.id, total: totalDecimal };
  });
}

async function createPayment(input: {
  id: string;
  customerId: string;
  amount: string;
  receivedAt: string;
  reference: string;
  applications: readonly { id: string; invoiceId: string; amount: string; appliedAt: string }[];
}): Promise<void> {
  const amountDecimal = canonicalMoney(input.amount, `payment ${input.id} amount`);
  await prisma.payment.create({
    data: {
      id: input.id,
      customerId: input.customerId,
      amount: legacyNumber(amountDecimal, moneyFormat),
      amountDecimal,
      currencyCode: CURRENCY,
      receivedAt: instant(input.receivedAt),
      reference: input.reference,
      applications: {
        create: input.applications.map((application) => {
          const applicationAmount = canonicalMoney(
            application.amount,
            `payment application ${application.id} amount`
          );
          return {
            id: application.id,
            invoiceId: application.invoiceId,
            amount: legacyNumber(applicationAmount, moneyFormat),
            amountDecimal: applicationAmount,
            appliedAt: instant(application.appliedAt),
          };
        }),
      },
    },
  });
}

async function main(): Promise<void> {
  await requireEmptyDatabase();

  await prisma.customer.createMany({
    data: [
      { id: "cust_acme", name: "Acme Logistics", email: "ap@acmelogistics.com", billingAddress: "1 Freight Way, Reno, NV", portalAccount: "ACME-AP-291", clearinghouseId: "TP-ACME-01" },
      { id: "cust_bluebird", name: "Bluebird Media", email: "billing@bluebird.media", billingAddress: "88 Aviary Ave, Austin, TX", clearinghouseId: "TP-BLUE-77" },
      { id: "cust_cascade", name: "Cascade Manufacturing", email: "payables@cascademfg.com", billingAddress: "400 Mill Rd, Tacoma, WA", portalAccount: "CASC-PORTAL-8" },
    ],
  });

  const products = [
    ["prod_seat", "SEAT-STD", "Standard Seat License", "seat/month", "45"],
    ["prod_storage", "STG-GB", "Object Storage", "GB/month", "0.12"],
    ["prod_api", "API-1K", "API Calls", "1k calls", "0.9"],
    ["prod_support", "SUP-PREM", "Premium Support", "contract/month", "1200"],
    ["prod_device", "DEV-TRK", "Fleet Tracker Device", "device", "210"],
  ] as const;
  await prisma.product.createMany({
    data: products.map(([id, sku, name, unit, listPrice]) => {
      const decimal = canonicalMoney(listPrice, `${sku} list price`);
      return { id, sku, name, unit, listPrice: legacyNumber(decimal, moneyFormat), listPriceDecimal: decimal, currencyCode: CURRENCY };
    }),
  });

  const rates: readonly {
    id: string;
    customerId: string;
    productId: string;
    unitPrice: string;
    tiers?: readonly SeedTier[];
    effectiveDate: string;
  }[] = [
    { id: "rate_acme_seat", customerId: "cust_acme", productId: "prod_seat", unitPrice: "39", tiers: [{ upTo: "100", unitPrice: "39" }, { upTo: "250", unitPrice: "34", floor: "500" }, { upTo: null, unitPrice: "29.5", ceiling: "12000" }], effectiveDate: "2025-01-01" },
    { id: "rate_acme_device", customerId: "cust_acme", productId: "prod_device", unitPrice: "185", tiers: [{ upTo: "50", unitPrice: "185" }, { upTo: "200", unitPrice: "172", floor: "2000" }, { upTo: null, unitPrice: "159", ceiling: "40000" }], effectiveDate: "2025-01-01" },
    { id: "rate_acme_support", customerId: "cust_acme", productId: "prod_support", unitPrice: "950", effectiveDate: "2025-01-01" },
    { id: "rate_acme_api", customerId: "cust_acme", productId: "prod_api", unitPrice: "0.85", tiers: [{ upTo: "500", unitPrice: "0.85", floor: "50" }, { upTo: null, unitPrice: "0.72" }], effectiveDate: "2025-01-01" },
    { id: "rate_blue_storage", customerId: "cust_bluebird", productId: "prod_storage", unitPrice: "0.1", tiers: [{ upTo: "5000", unitPrice: "0.1", floor: "150" }, { upTo: "20000", unitPrice: "0.085" }, { upTo: null, unitPrice: "0.07", ceiling: "2500" }], effectiveDate: "2025-03-01" },
    { id: "rate_blue_api", customerId: "cust_bluebird", productId: "prod_api", unitPrice: "0.8", tiers: [{ upTo: "1000", unitPrice: "0.8" }, { upTo: null, unitPrice: "0.66" }], effectiveDate: "2025-03-01" },
    { id: "rate_blue_seat", customerId: "cust_bluebird", productId: "prod_seat", unitPrice: "42", effectiveDate: "2025-03-01" },
    { id: "rate_casc_seat", customerId: "cust_cascade", productId: "prod_seat", unitPrice: "41", effectiveDate: "2025-06-01" },
    { id: "rate_casc_device", customerId: "cust_cascade", productId: "prod_device", unitPrice: "199", tiers: [{ upTo: "100", unitPrice: "199" }, { upTo: null, unitPrice: "180", floor: "1000" }], effectiveDate: "2025-06-01" },
    { id: "rate_casc_support", customerId: "cust_cascade", productId: "prod_support", unitPrice: "1100", effectiveDate: "2025-06-01" },
  ];
  await prisma.rate.createMany({
    data: rates.map((rate) => {
      const unitPriceDecimal = canonicalMoney(rate.unitPrice, `rate ${rate.id} unit price`);
      return {
        ...rate,
        unitPrice: legacyNumber(unitPriceDecimal, moneyFormat),
        unitPriceDecimal,
        currencyCode: CURRENCY,
        tiers: exactTiers(rate.tiers ?? []),
        effectiveDate: instant(rate.effectiveDate),
      };
    }),
  });

  const discounts = [
    ["combo_acme_platform", "cust_acme", "Platform Bundle", "10", ["prod_seat", "prod_support"]],
    ["combo_blue_data", "cust_bluebird", "Data Bundle", "12", ["prod_storage", "prod_api"]],
    ["combo_casc_fleet", "cust_cascade", "Fleet Bundle", "7.5", ["prod_seat", "prod_device"]],
    ["combo_global_devkit", null, "Seats + API Promo", "5", ["prod_seat", "prod_api"]],
  ] as const;
  for (const [id, customerId, name, percentOff, productIds] of discounts) {
    const percentOffDecimal = canonicalPercentage(percentOff, `${id} percent off`);
    await prisma.comboDiscount.create({
      data: {
        id,
        customerId,
        name,
        percentOff: legacyNumber(percentOffDecimal, { scale: 4, precision: 7, field: "percent off" }),
        percentOffDecimal,
        products: { connect: productIds.map((id) => ({ id })) },
      },
    });
  }

  const orders: readonly SeedOrder[] = [
    { id: "ord_1", customerId: "cust_acme", orderDate: "2025-05-12", status: "INVOICED", shipTo: "Acme Logistics HQ, 1 Freight Way, Reno, NV", items: [{ productId: "prod_seat", quantity: "120" }, { productId: "prod_support", quantity: "1" }] },
    { id: "ord_2", customerId: "cust_bluebird", orderDate: "2025-07-03", status: "INVOICED", shipTo: "Bluebird Media, 88 Aviary Ave, Austin, TX", items: [{ productId: "prod_storage", quantity: "8000" }, { productId: "prod_api", quantity: "1500" }] },
    { id: "ord_3", customerId: "cust_acme", orderDate: "2025-09-20", status: "INVOICED", shipTo: "Acme Depot 12, 340 Yard St, Sparks, NV", items: [{ productId: "prod_device", quantity: "60" }, { productId: "prod_seat", quantity: "120" }, { productId: "prod_support", quantity: "1" }] },
    { id: "ord_4", customerId: "cust_cascade", orderDate: "2025-11-08", status: "INVOICED", shipTo: "Cascade Plant 2, 410 Mill Rd, Tacoma, WA", items: [{ productId: "prod_seat", quantity: "35" }, { productId: "prod_device", quantity: "110" }] },
    { id: "ord_5", customerId: "cust_bluebird", orderDate: "2026-02-14", status: "INVOICED", shipTo: "Bluebird Media, 88 Aviary Ave, Austin, TX", items: [{ productId: "prod_storage", quantity: "25000" }, { productId: "prod_api", quantity: "900" }] },
    { id: "ord_6", customerId: "cust_cascade", orderDate: "2026-06-30", status: "INVOICED", shipTo: "Cascade Plant 2, 410 Mill Rd, Tacoma, WA", items: [{ productId: "prod_support", quantity: "1" }, { productId: "prod_seat", quantity: "35" }] },
    { id: "ord_7", customerId: "cust_acme", orderDate: "2026-07-22", status: "OPEN", shipTo: "Acme Logistics HQ, 1 Freight Way, Reno, NV", items: [{ productId: "prod_seat", quantity: "140" }, { productId: "prod_api", quantity: "600" }] },
    { id: "ord_8", customerId: "cust_bluebird", orderDate: "2026-08-05", status: "INVOICED", shipTo: "Bluebird Media, 88 Aviary Ave, Austin, TX", items: [{ productId: "prod_seat", quantity: "6" }] },
  ];
  for (const order of orders) await createOrder(order);

  await prisma.orderComment.createMany({
    data: [
      { id: "cmt_1", orderId: "ord_3", author: "d.kim", body: "Confirmed tracker count with Acme ops before shipping.", createdAt: new Date("2025-09-22T16:04:00Z") },
      { id: "cmt_2", orderId: "ord_3", author: "a.reyes", body: "Customer asked for NET-45 — declined, standard NET-30 applies.", createdAt: new Date("2025-09-28T19:41:00Z") },
      { id: "cmt_3", orderId: "ord_4", author: "d.kim", body: "Devices shipped in two batches; second batch landed Nov 18.", createdAt: new Date("2025-11-20T15:12:00Z") },
      { id: "cmt_4", orderId: "ord_6", author: "a.reyes", body: "Holding invoice until the support contract is countersigned.", createdAt: new Date("2026-07-02T17:30:00Z") },
    ],
  });

  const invoices = new Map<string, { id: string; total: string }>();
  const invoiceSeeds: readonly SeedInvoice[] = [
    { id: "inv_1", number: "INV-00001", orderId: "ord_1", issueDate: "2025-05-15", status: "PAID" },
    { id: "inv_2", number: "INV-00002", orderId: "ord_2", issueDate: "2025-07-10", status: "PAID" },
    { id: "inv_3", number: "INV-00003", orderId: "ord_3", issueDate: "2025-10-01", status: "SENT", amountPaid: "5000" },
    { id: "inv_4", number: "INV-00004", orderId: "ord_4", issueDate: "2026-01-12", status: "POSTED" },
    { id: "inv_5", number: "INV-00005", orderId: "ord_5", issueDate: "2026-03-02", status: "SENT", amountPaid: "1000" },
    { id: "inv_6", number: "INV-00006", orderId: "ord_6", issueDate: "2026-07-05", status: "DRAFT" },
    { id: "inv_7", number: "INV-00007", orderId: "ord_8", issueDate: "2026-08-10", status: "DRAFT" },
  ];
  for (const invoice of invoiceSeeds) invoices.set(invoice.id, await createInvoice(invoice));

  const inv1 = invoices.get("inv_1");
  const inv2 = invoices.get("inv_2");
  if (!inv1 || !inv2) throw new Error("seeded paid invoices are missing");
  await createPayment({ id: "pay_1", customerId: "cust_acme", amount: inv1.total, receivedAt: "2025-06-10", reference: "ACH 88231", applications: [{ id: "app_1", invoiceId: "inv_1", amount: inv1.total, appliedAt: "2025-06-10" }] });
  await createPayment({ id: "pay_2", customerId: "cust_bluebird", amount: inv2.total, receivedAt: "2025-08-02", reference: "CHK 1077", applications: [{ id: "app_2", invoiceId: "inv_2", amount: inv2.total, appliedAt: "2025-08-02" }] });
  await createPayment({ id: "pay_3", customerId: "cust_acme", amount: "5000", receivedAt: "2025-10-28", reference: "ACH 90112", applications: [{ id: "app_3", invoiceId: "inv_3", amount: "5000", appliedAt: "2025-10-28" }] });
  await createPayment({ id: "pay_4", customerId: "cust_bluebird", amount: "2500", receivedAt: "2026-03-20", reference: "WIRE 5541", applications: [{ id: "app_4", invoiceId: "inv_5", amount: "1000", appliedAt: "2026-03-22" }] });

  await prisma.transmission.createMany({
    data: [
      { id: "tx_1", invoiceId: "inv_3", method: "EMAIL", status: "SENT", detail: "Emailed to ap@acmelogistics.com" },
      { id: "tx_2", invoiceId: "inv_5", method: "PORTAL", status: "DELIVERED", externalJobId: "pj_seed0001", detail: "Upload queued for portal account BLUE-PORTAL" },
    ],
  });

  console.log("seeded:", {
    customers: await prisma.customer.count(),
    products: await prisma.product.count(),
    rates: await prisma.rate.count(),
    orders: await prisma.order.count(),
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
