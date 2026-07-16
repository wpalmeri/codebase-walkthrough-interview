// Domain money value object introduced during the (stalled) domain-model
// effort. Coexists with Prisma.Decimal (lib/money.ts) and raw integer cents
// (lib/money-cents.ts).

export interface DomainMoney {
  cents: number;
  currency: "USD";
}

export function domainMoney(cents: number): DomainMoney {
  return { cents: Math.round(cents), currency: "USD" };
}

export function domainMoneyFromDecimal(value: { toString(): string }): DomainMoney {
  return domainMoney(Math.round(Number(value.toString()) * 100));
}

export function addMoney(a: DomainMoney, b: DomainMoney): DomainMoney {
  return domainMoney(a.cents + b.cents);
}

export function subtractMoney(a: DomainMoney, b: DomainMoney): DomainMoney {
  return domainMoney(a.cents - b.cents);
}

export function moneyToNumber(value: DomainMoney): number {
  return value.cents / 100;
}

export function formatMoney(value: DomainMoney): string {
  return `$${(value.cents / 100).toFixed(2)}`;
}
