const DAY_MS = 86_400_000;

export function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}

export function startOfUtcDay(value: Date): Date {
  const copy = new Date(value);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

/** The date a visit was (or will be) rendered, independent of when it was recorded. */
export function serviceDateOf(visit: { actualStart: Date | null; scheduledStart: Date }): Date {
  return startOfUtcDay(visit.actualStart ?? visit.scheduledStart);
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

export function hoursAgo(hours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - hours * 3_600_000);
}
