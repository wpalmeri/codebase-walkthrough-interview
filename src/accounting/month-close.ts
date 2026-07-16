import { PeriodStatus, Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { monthBounds } from "../lib/dates.js";
import { recognizedRevenueForWindow } from "./revenue-calculation.js";
import { writeAudit } from "../audit/audit-service.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_PERIOD_CLOSED } from "../events/event-names.js";

/**
 * Month close.
 *
 * Closing a period is only a status flag: closePeriod flips the period to
 * CLOSED and stamps who/when. It does not snapshot anything. Every figure a
 * period reports — revenue, receivables — is re-derived on read from live
 * operational tables and the *currently active* rates and coverage
 * (calculatePeriod -> recognizedRevenueForWindow). Nothing blocks writes dated
 * inside a closed period either. So a rate edit, a coverage correction, or a
 * visit amendment after the close silently moves what a closed month reports
 * the next time anyone looks (INC-1101). This is the same live-pricing gap the
 * revenue report and patient statements read through — the close is just where
 * finance notices it. PeriodAdjustment exists for explicit corrections but the
 * close path never writes one.
 */
export async function calculatePeriod(periodId: string) {
  const period = await db.accountingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  const { start, end } = monthBounds(period.year, period.month);

  const { revenue, visitCount, sources } = await recognizedRevenueForWindow(period.organizationId, start, end);

  const receivables = await db.claim.aggregate({
    where: { organizationId: period.organizationId, status: { notIn: ["PAID", "VOIDED"] } },
    _sum: { balanceAmount: true },
  });

  const cash = await db.payment.aggregate({
    where: { organizationId: period.organizationId, receivedAt: { gte: start, lt: end } },
    _sum: { amount: true },
  });

  const unbilledVisits = await db.visit.count({
    where: {
      status: "COMPLETED",
      completedAt: { gte: start, lt: end },
      charges: { none: {} },
      visitGroup: { visitSet: { organizationId: period.organizationId } },
    },
  });

  return {
    period,
    window: { start, end },
    revenue,
    receivables: receivables._sum.balanceAmount ?? new Prisma.Decimal(0),
    cashReceived: cash._sum.amount ?? new Prisma.Decimal(0),
    visitCount,
    unbilledVisits,
    sources,
  };
}

/**
 * Closing a period flips its status and records who closed it and when. It
 * stores no totals: the period keeps reporting whatever calculatePeriod
 * derives from current data at read time. Closing an already-closed period is
 * not blocked — finance re-closes after corrections and the flag simply
 * stays CLOSED.
 */
export async function closePeriod(periodId: string, userId: string) {
  const period = await db.accountingPeriod.update({
    where: { id: periodId },
    data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: userId },
  });
  await writeAudit(period.organizationId, userId, "period.closed", "AccountingPeriod", periodId, {
    year: period.year,
    month: period.month,
  });
  await emitDomainEvent({
    organizationId: period.organizationId,
    eventName: EVENT_PERIOD_CLOSED,
    aggregateType: "AccountingPeriod",
    aggregateId: periodId,
    payload: { periodId, year: period.year, month: period.month },
    emittedBy: userId,
  });
  return period;
}

/**
 * The period's financial position for the accounting screen. Recomputed from
 * live data on every call (see calculatePeriod) — there is no stored position
 * to return, so a closed period's numbers here are whatever the current rate
 * and coverage tables produce.
 */
export async function periodFinancials(periodId: string) {
  const current = await calculatePeriod(periodId);
  return {
    periodId,
    status: current.period.status,
    closedAt: current.period.closedAt,
    recognizedRevenue: Number(current.revenue),
    outstandingReceivables: Number(current.receivables),
    cashReceived: Number(current.cashReceived),
    unbilledVisits: current.unbilledVisits,
  };
}

export async function addPeriodAdjustment(periodId: string, description: string, amount: number, createdBy: string) {
  return db.periodAdjustment.create({
    data: { periodId, description, amount: new Prisma.Decimal(amount.toFixed(2)), createdBy },
  });
}
