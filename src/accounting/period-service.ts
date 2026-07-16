import { PeriodStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { writeAudit } from "../audit/audit-service.js";

export async function listPeriods(context: RequestContext) {
  const periods = await db.accountingPeriod.findMany({
    where: { organizationId: context.organizationId },
    include: { adjustments: true },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  return periods.map((period) => ({
    id: period.id,
    year: period.year,
    month: period.month,
    status: period.status,
    closedAt: period.closedAt,
    closedBy: period.closedBy,
    reopenedAt: period.reopenedAt,
    adjustmentTotal: period.adjustments.reduce((sum, adjustment) => sum + Number(adjustment.amount), 0),
  }));
}

export async function reopenPeriod(context: RequestContext, periodId: string, reason: string) {
  const period = await db.accountingPeriod.findFirst({ where: { id: periodId, organizationId: context.organizationId } });
  if (!period) throw new NotFoundError("Period not found");
  if (period.status !== PeriodStatus.CLOSED) throw new ConflictError("Only closed periods can be reopened");
  const updated = await db.accountingPeriod.update({
    where: { id: periodId },
    data: { status: PeriodStatus.REOPENED, reopenedAt: new Date(), reopenedBy: context.userId, notes: reason },
  });
  await writeAudit(context.organizationId, context.userId, "period.reopened", "AccountingPeriod", periodId, { reason });
  return updated;
}

export async function ensurePeriod(organizationId: string, year: number, month: number) {
  return db.accountingPeriod.upsert({
    where: { organizationId_year_month: { organizationId, year, month } },
    create: { organizationId, year, month },
    update: {},
  });
}
