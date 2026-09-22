import { z } from "zod";
import {
  MoneyStringSchema,
  PercentageStringSchema,
  QuantityStringSchema,
} from "./decimal.js";
import { TransmissionMethodSchema } from "./requests.js";

const id = z.string().min(1);
const isoDateTime = z.iso.datetime({ offset: true });
const money = z.number().finite();
const nonNegativeMoney = money.nonnegative();

/** ISO 4217 storage code syntax; membership is enforced by the application code list. */
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export const EmailAddressSchema = z.email();

export const OrderStatusSchema = z.enum(["OPEN", "INVOICED", "CLOSED"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const InvoiceStatusSchema = z.enum(["DRAFT", "POSTED", "SENT", "PAID", "VOID"]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export type TransmissionMethod = z.infer<typeof TransmissionMethodSchema>;

export const TransmissionStatusSchema = z.enum([
  "QUEUED",
  "UPLOADING",
  "DELIVERED",
  "SENT",
  "ACCEPTED",
  "FAILED",
]);
export type TransmissionStatus = z.infer<typeof TransmissionStatusSchema>;

export const CustomerSchema = z.object({
  id,
  name: z.string(),
  email: EmailAddressSchema,
  billingAddress: z.string().nullable(),
  portalAccount: z.string().nullable(),
  clearinghouseId: z.string().nullable(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const ProductSchema = z.object({
  id,
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  listPrice: nonNegativeMoney,
  listPriceDecimal: MoneyStringSchema.optional(),
  currencyCode: CurrencyCodeSchema.optional(),
});
export type Product = z.infer<typeof ProductSchema>;

export const RateTierSchema = z.object({
  upTo: z.number().positive().nullable(),
  unitPrice: nonNegativeMoney,
  floor: nonNegativeMoney.nullish(),
  ceiling: nonNegativeMoney.nullish(),
});
export type RateTier = z.infer<typeof RateTierSchema>;

export const ExactRateTierSchema = z.object({
  upTo: QuantityStringSchema.nullable(),
  unitPrice: MoneyStringSchema,
  floor: MoneyStringSchema.nullish(),
  ceiling: MoneyStringSchema.nullish(),
});
export type ExactRateTier = z.infer<typeof ExactRateTierSchema>;

export const RateSchema = z.object({
  id,
  customerId: id,
  productId: id,
  productSku: z.string().optional(),
  productName: z.string().optional(),
  unitPrice: nonNegativeMoney,
  unitPriceDecimal: MoneyStringSchema.optional(),
  currencyCode: CurrencyCodeSchema.optional(),
  tiers: z.array(RateTierSchema),
  tiersDecimal: z.array(ExactRateTierSchema).optional(),
  effectiveDate: isoDateTime,
});
export type Rate = z.infer<typeof RateSchema>;

export const ComboDiscountSchema = z.object({
  id,
  customerId: id.nullable(),
  name: z.string(),
  products: z.array(z.object({ id, sku: z.string(), name: z.string() })),
  percentOff: z.number().min(0).max(100),
  percentOffDecimal: PercentageStringSchema.optional(),
});
export type ComboDiscount = z.infer<typeof ComboDiscountSchema>;

export const OrderItemSchema = z.object({
  id,
  productId: id,
  productSku: z.string().optional(),
  productName: z.string().optional(),
  rateId: id,
  quantity: z.number().positive(),
  unitPrice: nonNegativeMoney,
  amount: nonNegativeMoney,
  quantityDecimal: QuantityStringSchema.optional(),
  baseUnitPriceDecimal: MoneyStringSchema.optional(),
  effectiveUnitPriceDecimal: MoneyStringSchema.optional(),
  amountDecimal: MoneyStringSchema.optional(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderCommentSchema = z.object({
  id,
  author: z.string(),
  body: z.string(),
  createdAt: isoDateTime,
});
export type OrderComment = z.infer<typeof OrderCommentSchema>;

export const OrderSchema = z.object({
  id,
  reference: z.string().nullable(),
  customerId: id,
  customerName: z.string().optional(),
  customerEmail: EmailAddressSchema.optional(),
  billingAddress: z.string().nullable().optional(),
  orderDate: isoDateTime,
  status: OrderStatusSchema,
  shipTo: z.string().nullable(),
  notes: z.string().nullable(),
  currencyCode: CurrencyCodeSchema.optional(),
  totalDecimal: MoneyStringSchema.optional(),
  items: z.array(OrderItemSchema),
  comments: z.array(OrderCommentSchema),
  total: nonNegativeMoney,
  invoiceId: id.nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceStatus: InvoiceStatusSchema.nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const TransmissionSchema = z.object({
  id,
  invoiceId: id,
  method: TransmissionMethodSchema,
  status: TransmissionStatusSchema,
  externalJobId: z.string().nullable(),
  detail: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Transmission = z.infer<typeof TransmissionSchema>;

export const InvoiceLineSchema = z.object({
  id,
  description: z.string(),
  quantity: z.number().positive(),
  unitPrice: nonNegativeMoney,
  amount: nonNegativeMoney,
  quantityDecimal: QuantityStringSchema.optional(),
  unitPriceDecimal: MoneyStringSchema.optional(),
  amountDecimal: MoneyStringSchema.optional(),
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

export const InvoicePaymentSchema = z.object({
  id,
  paymentId: id,
  amount: nonNegativeMoney,
  amountDecimal: MoneyStringSchema.optional(),
  receivedAt: isoDateTime,
  reference: z.string().nullable(),
});
export type InvoicePayment = z.infer<typeof InvoicePaymentSchema>;

export const InvoiceSchema = z.object({
  id,
  number: z.string(),
  customerId: id,
  customerName: z.string().optional(),
  customerEmail: EmailAddressSchema.optional(),
  billingAddress: z.string().nullable().optional(),
  orderId: id,
  orderReference: z.string().nullable().optional(),
  status: InvoiceStatusSchema,
  issueDate: isoDateTime,
  dueDate: isoDateTime,
  accountingDate: z.iso.date().optional(),
  total: nonNegativeMoney,
  amountPaid: nonNegativeMoney,
  totalDecimal: MoneyStringSchema.optional(),
  amountPaidDecimal: MoneyStringSchema.optional(),
  currencyCode: CurrencyCodeSchema.optional(),
  balance: money,
  balanceDecimal: MoneyStringSchema.optional(),
  postedAt: isoDateTime.nullable(),
  lines: z.array(InvoiceLineSchema),
  payments: z.array(InvoicePaymentSchema),
  transmissions: z.array(TransmissionSchema),
  lastTransmission: TransmissionSchema.nullable(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const PaymentApplicationSchema = z.object({
  id,
  invoiceId: id,
  invoiceNumber: z.string().optional(),
  amount: nonNegativeMoney,
  amountDecimal: MoneyStringSchema.optional(),
  appliedAt: isoDateTime,
});
export type PaymentApplication = z.infer<typeof PaymentApplicationSchema>;

export const PaymentSchema = z.object({
  id,
  customerId: id,
  customerName: z.string().optional(),
  amount: nonNegativeMoney,
  amountDecimal: MoneyStringSchema.optional(),
  currencyCode: CurrencyCodeSchema.optional(),
  receivedAt: isoDateTime,
  reference: z.string().nullable(),
  applied: nonNegativeMoney,
  unapplied: nonNegativeMoney,
  appliedDecimal: MoneyStringSchema.optional(),
  unappliedDecimal: MoneyStringSchema.optional(),
  applications: z.array(PaymentApplicationSchema),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const QuarterRevenueSchema = z.object({
  quarter: z.string(),
  invoiceCount: z.number().int().nonnegative(),
  revenue: nonNegativeMoney,
  revenueDecimal: MoneyStringSchema.optional(),
});
export type QuarterRevenue = z.infer<typeof QuarterRevenueSchema>;

export const CustomerRevenueSchema = z.object({
  customerId: id,
  customerName: z.string(),
  invoiceCount: z.number().int().nonnegative(),
  revenue: nonNegativeMoney,
  revenueDecimal: MoneyStringSchema.optional(),
});
export type CustomerRevenue = z.infer<typeof CustomerRevenueSchema>;

export const AnnualRevenueSchema = z.object({
  year: z.number().int(),
  invoiceCount: z.number().int().nonnegative(),
  revenue: nonNegativeMoney,
  revenueDecimal: MoneyStringSchema.optional(),
});
export type AnnualRevenue = z.infer<typeof AnnualRevenueSchema>;

export * from "./requests.js";
export * from "./decimal.js";
