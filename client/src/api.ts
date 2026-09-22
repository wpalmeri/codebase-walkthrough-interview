import {
  AnnualRevenueSchema,
  ComboDiscountSchema,
  CustomerRevenueSchema,
  CustomerSchema,
  InvoiceSchema,
  OrderSchema,
  PaymentSchema,
  ProblemDetailsSchema,
  ProductSchema,
  QuarterRevenueSchema,
  RateSchema,
  TransmissionSchema,
} from "@meridian/contracts";

const responseSchemas = {
  annualRevenue: AnnualRevenueSchema.array(),
  comboDiscount: ComboDiscountSchema,
  comboDiscounts: ComboDiscountSchema.array(),
  customerRevenue: CustomerRevenueSchema.array(),
  customers: CustomerSchema.array(),
  invoice: InvoiceSchema,
  invoices: InvoiceSchema.array(),
  order: OrderSchema,
  orders: OrderSchema.array(),
  payment: PaymentSchema,
  payments: PaymentSchema.array(),
  product: ProductSchema,
  products: ProductSchema.array(),
  quarterRevenue: QuarterRevenueSchema.array(),
  rate: RateSchema,
  rates: RateSchema.array(),
  transmission: TransmissionSchema,
};

type ResponseSchema = (typeof responseSchemas)[keyof typeof responseSchemas];

type JsonBody =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "json"; value: unknown };

async function readJsonBody(res: Response): Promise<JsonBody> {
  const text = await res.text();
  if (text.trim().length === 0) return { kind: "empty" };

  try {
    const value: unknown = JSON.parse(text);
    return { kind: "json", value };
  } catch {
    return { kind: "invalid" };
  }
}

function responseSchema(method: string, path: string): ResponseSchema | undefined {
  const pathname = path.split("?", 1)[0] ?? path;

  if (method === "GET") {
    if (pathname === "/customers") return responseSchemas.customers;
    if (pathname === "/products") return responseSchemas.products;
    if (pathname === "/orders") return responseSchemas.orders;
    if (pathname === "/invoices") return responseSchemas.invoices;
    if (pathname === "/payments") return responseSchemas.payments;
    if (pathname === "/rates") return responseSchemas.rates;
    if (pathname === "/rates/combos") return responseSchemas.comboDiscounts;
    if (pathname === "/reports/revenue-by-quarter") return responseSchemas.quarterRevenue;
    if (pathname === "/reports/revenue-by-customer") return responseSchemas.customerRevenue;
    if (pathname === "/reports/annual-revenue") return responseSchemas.annualRevenue;
    if (/^\/orders\/[^/]+$/u.test(pathname)) return responseSchemas.order;
    if (/^\/invoices\/[^/]+$/u.test(pathname)) return responseSchemas.invoice;
    if (/^\/rates\/[^/]+$/u.test(pathname)) return responseSchemas.rate;
  }

  if (method === "POST") {
    if (pathname === "/payments") return responseSchemas.payment;
    if (pathname === "/rates/combos") return responseSchemas.comboDiscount;
    if (/^\/payments\/[^/]+\/apply$/u.test(pathname)) return responseSchemas.payment;
    if (/^\/orders\/[^/]+\/invoice$/u.test(pathname)) return responseSchemas.invoice;
    if (/^\/invoices\/[^/]+\/(?:post|send)$/u.test(pathname)) return responseSchemas.invoice;
    if (/^\/invoices\/transmissions\/[^/]+\/refresh$/u.test(pathname)) {
      return responseSchemas.transmission;
    }
  }

  if (method === "PUT") {
    if (/^\/orders\/[^/]+$/u.test(pathname)) return responseSchemas.order;
    if (/^\/invoices\/[^/]+$/u.test(pathname)) return responseSchemas.invoice;
    if (/^\/rates\/[^/]+$/u.test(pathname)) return responseSchemas.rate;
  }

  return undefined;
}

async function handle(res: Response, schema: ResponseSchema | undefined): Promise<unknown> {
  const body = await readJsonBody(res);

  if (!res.ok) {
    if (body.kind === "json") {
      const problem = ProblemDetailsSchema.safeParse(body.value);
      if (problem.success) throw new Error(`Request failed (${res.status}): ${problem.data.code}`);
    }
    throw new Error(`Request failed (${res.status})`);
  }

  if (body.kind === "empty") throw new Error("Received an empty response.");
  if (body.kind === "invalid") throw new Error("Received a non-JSON response.");
  if (schema === undefined) throw new Error("Unsupported API response.");

  const parsed = schema.safeParse(body.value);
  if (!parsed.success) throw new Error("Received an invalid response.");

  return parsed.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

export function apiGet<T>(path: string): Promise<T>;
export function apiGet(path: string): Promise<unknown> {
  return fetch(`/api${path}`).then((res) => handle(res, responseSchema("GET", path)));
}

export function apiPost<T>(path: string, body?: unknown): Promise<T>;
export function apiPost(path: string, body?: unknown): Promise<unknown> {
  return fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => handle(res, responseSchema("POST", path)));
}

export function apiPut<T>(path: string, body?: unknown): Promise<T>;
export function apiPut(path: string, body?: unknown): Promise<unknown> {
  return fetch(`/api${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => handle(res, responseSchema("PUT", path)));
}

export type FinancialValue = string | number;

function scaledCoefficient(value: FinancialValue, scale = 4): bigint {
  const text = typeof value === "number" ? value.toFixed(scale) : value;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(text);
  if (!match) throw new Error("Invalid decimal value");
  const fraction = match[3] ?? "";
  if (fraction.length > scale) throw new Error(`Decimal value exceeds ${scale} places`);
  const coefficient = BigInt(`${match[2]}${fraction.padEnd(scale, "0")}`);
  return match[1] === "-" ? -coefficient : coefficient;
}

function canonicalMoney(coefficient: bigint): string {
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const text = absolute.toString().padStart(5, "0");
  const value = `${text.slice(0, -4)}.${text.slice(-4)}`;
  return negative ? `-${value}` : value;
}

export function financialValue(exact: string | undefined, legacy: number): FinancialValue {
  return exact ?? legacy;
}

export function sumMoney(values: readonly FinancialValue[]): string {
  return canonicalMoney(
    values.reduce<bigint>((sum, value) => sum + scaledCoefficient(value), 0n)
  );
}

export function isPositiveMoney(value: FinancialValue): boolean {
  return scaledCoefficient(value) > 0n;
}

export function decimalNumber(value: FinancialValue): number {
  return Number(value);
}

export function decimalDisplay(value: FinancialValue): string {
  if (typeof value === "number") return String(value);
  return value.includes(".") ? value.replace(/\.?0+$/u, "") : value;
}

export function money(value: FinancialValue): string {
  if (typeof value === "number") {
    return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
  const coefficient = scaledCoefficient(value);
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const cents = (absolute + 50n) / 100n;
  const dollars = cents / 100n;
  const remainder = (cents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${remainder}`;
}

export function compactMoney(value: FinancialValue): string {
  const n = decimalNumber(value);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  return money(value);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
