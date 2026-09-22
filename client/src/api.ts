async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? res.statusText);
  }
  return res.json();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

export function apiGet<T>(path: string): Promise<T> {
  return fetch(`/api${path}`).then((res) => handle<T>(res));
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => handle<T>(res));
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return fetch(`/api${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => handle<T>(res));
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
