// Integer-cent money helpers used by cash application and statements.
// Predates lib/money.ts (Prisma.Decimal); both remain in active use.

export function toCents(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function addCents(...values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export function splitCents(totalCents: number, ways: number): number[] {
  const base = Math.floor(totalCents / ways);
  const remainder = totalCents - base * ways;
  return Array.from({ length: ways }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function percentOfCents(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}
