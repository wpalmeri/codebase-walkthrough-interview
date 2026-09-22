import { z } from "zod";

/** A calendar date deliberately has no timezone or time-of-day component. */
export const AccountingDateSchema = z.iso.date();
export type AccountingDate = z.infer<typeof AccountingDateSchema>;

/** The database table permits only this singleton control row. */
export const AccountingPeriodControlSchema = z.strictObject({
  id: z.literal(1),
  closedThroughDate: AccountingDateSchema.nullable(),
});
export type AccountingPeriodControl = z.infer<typeof AccountingPeriodControlSchema>;

export function parseAccountingDate(value: unknown): AccountingDate {
  return AccountingDateSchema.parse(value);
}

/**
 * Compatibility boundary for legacy timestamp columns. New accounting policy
 * must pass an already chosen calendar date, not infer one from local time.
 */
export function utcAccountingDateFromInstant(instant: Date): AccountingDate {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error("instant must be a valid Date");
  }
  return parseAccountingDate(instant.toISOString().slice(0, 10));
}

export function compareAccountingDates(left: AccountingDate, right: AccountingDate): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** The close boundary is inclusive: 2026-01-31 closes all of January. */
export function isAccountingDateClosed(
  accountingDate: AccountingDate,
  closedThroughDate: AccountingDate | null
): boolean {
  return closedThroughDate !== null && compareAccountingDates(accountingDate, closedThroughDate) <= 0;
}

/** Rejects posts and redates that would alter a closed accounting period. */
export function assertAccountingDateOpen(
  accountingDate: AccountingDate,
  closedThroughDate: AccountingDate | null
): void {
  if (isAccountingDateClosed(accountingDate, closedThroughDate)) {
    throw new Error(`accounting date ${accountingDate} is in a closed period`);
  }
}
