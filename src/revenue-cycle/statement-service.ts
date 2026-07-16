import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { roundToWholeDollars } from "../pricing/rounding.js";
import { usesLegacyStatementFormat } from "../config/customer-overrides.js";
import { toCents, fromCents, percentOfCents } from "../lib/money-cents.js";

/**
 * Patient statements.
 *
 * Statement amounts are computed from the patient's *current* coverage and
 * *current* contract rates — not from claim balances or payments — using a
 * hardcoded 20% coinsurance when the plan doesn't specify one. Amounts are
 * assembled in integer cents, stored as Decimal, and (for Lakeside's mail
 * vendor) rounded to whole dollars. None of the intermediate math is kept.
 */
export async function generateStatement(patientId: string, start: Date, end: Date) {
  const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId }, include: { organization: true } });
  const coverage = await db.insuranceCoverage.findUniqueOrThrow({ where: { id: patient.currentCoverageId! } });
  const visits = await db.visit.findMany({
    where: { patientId, scheduledStart: { gte: start, lt: end }, status: "COMPLETED" },
    include: { visitGroup: { include: { visitSet: true } } },
  });

  let amountCents = 0;
  for (const visit of visits) {
    const rate = await db.payerRate.findFirst({
      where: { serviceType: visit.visitGroup.visitSet.serviceType, contract: { payerId: coverage.payerId } },
    });
    const rateCents = toCents(rate ? rate.amount.toString() : 100);
    const coinsurance = coverage.coinsurancePercent ?? 20;
    amountCents += percentOfCents(rateCents, coinsurance);
  }

  let amount = new Prisma.Decimal(fromCents(amountCents).toFixed(2));
  if (usesLegacyStatementFormat(patient.organization.slug)) {
    amount = roundToWholeDollars(amount);
  }

  return db.patientStatement.create({
    data: {
      patientId,
      periodStart: start,
      periodEnd: end,
      amount,
      payload: { visitIds: visits.map((visit) => visit.id), coverageId: coverage.id, coinsuranceApplied: coverage.coinsurancePercent ?? 20 },
    },
  });
}

/**
 * Batch statement generation for a period. Runs statements sequentially in
 * the request; the batch row is only updated at the end, so a crash midway
 * leaves generated statements attached to a PENDING batch.
 */
export async function generateStatementBatch(organizationId: string, start: Date, end: Date, requestedBy: string) {
  const batch = await db.statementBatch.create({
    data: { organizationId, periodStart: start, periodEnd: end, requestedBy },
  });

  const patients = await db.patient.findMany({
    where: {
      organizationId,
      currentCoverageId: { not: null },
      visits: { some: { status: "COMPLETED", scheduledStart: { gte: start, lt: end } } },
    },
  });

  let total = new Prisma.Decimal(0);
  let count = 0;
  for (const patient of patients) {
    const statement = await generateStatement(patient.id, start, end);
    await db.patientStatement.update({ where: { id: statement.id }, data: { batchId: batch.id } });
    total = total.add(statement.amount);
    count += 1;
  }

  return db.statementBatch.update({
    where: { id: batch.id },
    data: { status: "GENERATED", statementCount: count, totalAmount: total, generatedAt: new Date() },
  });
}

export async function listStatements(organizationId: string, limit = 50) {
  const statements = await db.patientStatement.findMany({
    orderBy: { generatedAt: "desc" },
    take: limit,
  });
  // PatientStatement has no organization column; scope by loading patients.
  const rows = [];
  for (const statement of statements) {
    const patient = await db.patient.findUnique({ where: { id: statement.patientId } });
    if (patient?.organizationId !== organizationId) continue;
    rows.push({
      id: statement.id,
      patientName: `${patient.lastName}, ${patient.firstName}`,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      amount: Number(statement.amount),
      status: statement.status,
      generatedAt: statement.generatedAt,
    });
  }
  return rows;
}
