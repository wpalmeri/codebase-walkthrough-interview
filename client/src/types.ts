export interface Customer {
  id: string;
  name: string;
  email: string;
  billingAddress: string | null;
  portalAccount: string | null;
  clearinghouseId: string | null;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  unit: string;
  listPrice: number;
}

// A quantity interval: units inside it bill at unitPrice; the interval charge is
// clamped between floor and ceiling. Item price = blended across intervals.
export interface RateTier {
  upTo: number | null;
  unitPrice: number;
  floor?: number | null;
  ceiling?: number | null;
}

export interface Rate {
  id: string;
  customerId: string;
  productId: string;
  productSku?: string;
  productName?: string;
  unitPrice: number;
  tiers: RateTier[];
  effectiveDate: string;
}

export interface ComboDiscount {
  id: string;
  customerId: string | null; // null = global
  name: string;
  products: { id: string; sku: string; name: string }[];
  percentOff: number;
}

export interface OrderItem {
  id: string;
  productId: string;
  productSku?: string;
  productName?: string;
  rateId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface OrderComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface Order {
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
  items: OrderItem[];
  comments: OrderComment[];
  total: number;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
}

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoicePayment {
  id: string;
  paymentId: string;
  amount: number;
  receivedAt: string;
  reference: string | null;
}

export interface Transmission {
  id: string;
  invoiceId: string;
  method: string;
  status: string;
  externalJobId: string | null;
  detail: string | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  customerName?: string;
  customerEmail?: string;
  billingAddress?: string | null;
  orderId: string;
  orderReference?: string | null;
  status: string;
  issueDate: string;
  dueDate: string;
  total: number;
  amountPaid: number;
  balance: number;
  postedAt: string | null;
  lines: InvoiceLine[];
  payments: InvoicePayment[];
  transmissions: Transmission[];
  lastTransmission: Transmission | null;
}

export interface PaymentApplication {
  id: string;
  invoiceId: string;
  invoiceNumber?: string;
  amount: number;
  appliedAt: string;
}

export interface Payment {
  id: string;
  customerId: string;
  customerName?: string;
  amount: number;
  receivedAt: string;
  reference: string | null;
  applied: number;
  unapplied: number;
  applications: PaymentApplication[];
}

export interface QuarterRevenue {
  quarter: string;
  invoiceCount: number;
  revenue: number;
}

export interface CustomerRevenue {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  revenue: number;
}

export interface AnnualRevenue {
  year: number;
  invoiceCount: number;
  revenue: number;
}
