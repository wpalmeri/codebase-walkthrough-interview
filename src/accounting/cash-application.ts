import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { toCents, fromCents } from "../lib/money-cents.js";
import { writePosting, ACCOUNTS } from "./posting-service.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_PAYMENT_POSTED, EVENT_PAYMENT_REVERSED } from "../events/event-names.js";

export async function importPayment(organizationId: string, externalId: string, amount: number, receivedAt: Date) {
  const payment = await db.payment.create({ data: { organizationId, externalId, amount, unappliedAmount: amount, receivedAt } });
  await emitDomainEvent({
    organizationId,
    eventName: EVENT_PAYMENT_POSTED,
    aggregateType: "Payment",
    aggregateId: payment.id,
    payload: { paymentId: payment.id, amount },
  });
  return payment;
}

/**
 * Applies cash to a claim in three separate writes (application row, payment
 * balance, claim balance) with no transaction and no idempotency key. A retry
 * after a mid-sequence failure — or a double-click — inserts a second
 * application row and decrements both balances twice (INC-1088's cash-side
 * twin). Claim math runs in integer cents, payment math in Decimal.
 */
export async function applyCash(paymentId: string, claimId: string, amount: number) {
  const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const claim = await db.claim.findUniqueOrThrow({ where: { id: claimId } });

  const value = new Prisma.Decimal(amount);
  const application = await db.cashApplication.create({ data: { paymentId, claimId, amount: value } });

  await db.payment.update({ where: { id: paymentId }, data: { unappliedAmount: payment.unappliedAmount.minus(value) } });

  const newBalanceCents = toCents(claim.balanceAmount.toString()) - toCents(amount);
  await db.claim.update({
    where: { id: claimId },
    data: {
      balanceAmount: new Prisma.Decimal(fromCents(newBalanceCents).toFixed(2)),
      status: newBalanceCents <= 0 ? "PAID" : claim.status,
    },
  });

  await writePosting({
    organizationId: payment.organizationId,
    sourceType: "cash-application",
    sourceId: application.id,
    postingDate: new Date(),
    amount: value,
    account: ACCOUNTS.CASH,
    metadata: { paymentId, claimId },
  });

  return application;
}

/**
 * Auto-application for a remittance line: matches by claim external id, then
 * falls back to (patient last name + open balance) — the fuzzy path that
 * INC-1115's postmortem flagged and nobody removed.
 */
export async function autoApplyRemittanceLine(remittanceLineId: string) {
  const line = await db.remittanceLine.findUniqueOrThrow({ where: { id: remittanceLineId }, include: { file: true } });
  if (line.status === "APPLIED") throw new ConflictError("Remittance line already applied");

  let claim = line.claimExternalId
    ? await db.claim.findFirst({ where: { externalId: line.claimExternalId, organizationId: line.file.organizationId } })
    : null;

  if (!claim && line.patientLastName) {
    const candidatePatients = await db.patient.findMany({
      where: { organizationId: line.file.organizationId, lastName: { equals: line.patientLastName, mode: "insensitive" } },
      select: { id: true },
    });
    claim = await db.claim.findFirst({
      where: {
        organizationId: line.file.organizationId,
        patientId: { in: candidatePatients.map((patient) => patient.id) },
        status: { in: ["SUBMITTED", "ACCEPTED"] },
        balanceAmount: line.billedAmount,
      },
    });
  }

  if (!claim) {
    await db.remittanceLine.update({ where: { id: line.id }, data: { status: "UNMATCHED" } });
    return { matched: false as const, remittanceLineId: line.id };
  }

  const payment = await db.payment.upsert({
    where: { organizationId_externalId: { organizationId: line.file.organizationId, externalId: `${line.file.externalId}:${line.id}` } },
    create: {
      organizationId: line.file.organizationId,
      externalId: `${line.file.externalId}:${line.id}`,
      amount: line.paidAmount,
      unappliedAmount: line.paidAmount,
      receivedAt: line.file.receivedAt,
      remittanceFileId: line.fileId,
      status: "RECEIVED",
    },
    update: {},
  });

  const application = await applyCash(payment.id, claim.id, Number(line.paidAmount));
  await db.remittanceLine.update({ where: { id: line.id }, data: { status: "APPLIED", matchedClaimId: claim.id } });
  return { matched: true as const, applicationId: application.id, claimId: claim.id };
}

/**
 * Reversal: restores both balances, then DELETES the application row. The
 * only durable trace is the cash posting written at apply time (when the
 * apply path got that far); reconciliation reports that recompute "applied"
 * from application rows never see reversed history.
 */
export async function reverseCashApplication(applicationId: string) {
  const application = await db.cashApplication.findUniqueOrThrow({ where: { id: applicationId }, include: { payment: true } });
  await db.payment.update({ where: { id: application.paymentId }, data: { unappliedAmount: { increment: application.amount } } });
  await db.claim.update({ where: { id: application.claimId }, data: { balanceAmount: { increment: application.amount } } });
  const deleted = await db.cashApplication.delete({ where: { id: applicationId } });
  await emitDomainEvent({
    organizationId: application.payment.organizationId,
    eventName: EVENT_PAYMENT_REVERSED,
    aggregateType: "Payment",
    aggregateId: application.paymentId,
    payload: { applicationId, claimId: application.claimId, amount: application.amount.toString() },
  });
  return deleted;
}

/** Compares stored unapplied balances against the surviving application rows. */
export async function reconciliation(organizationId: string) {
  const payments = await db.payment.findMany({ where: { organizationId }, include: { applications: true } });
  return payments.map((payment) => {
    const applied = payment.applications.reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0));
    return { paymentId: payment.id, expectedUnapplied: payment.amount.minus(applied), storedUnapplied: payment.unappliedAmount, matches: payment.amount.minus(applied).equals(payment.unappliedAmount) };
  });
}

export async function unappliedCashSummary(organizationId: string) {
  const payments = await db.payment.findMany({ where: { organizationId, unappliedAmount: { gt: 0 } }, orderBy: { receivedAt: "asc" } });
  const total = payments.reduce((sum, payment) => sum + Number(payment.unappliedAmount), 0);
  return {
    count: payments.length,
    totalUnapplied: Math.round(total * 100) / 100,
    oldest: payments[0]?.receivedAt ?? null,
    payments: payments.map((payment) => ({
      id: payment.id,
      externalId: payment.externalId,
      receivedAt: payment.receivedAt,
      amount: Number(payment.amount),
      unappliedAmount: Number(payment.unappliedAmount),
    })),
  };
}

export async function listPayments(organizationId: string, limit = 50) {
  const payments = await db.payment.findMany({
    where: { organizationId },
    include: { applications: { include: { claim: true } } },
    orderBy: { receivedAt: "desc" },
    take: limit,
  });
  return payments.map((payment) => ({
    id: payment.id,
    externalId: payment.externalId,
    method: payment.method,
    amount: Number(payment.amount),
    unappliedAmount: Number(payment.unappliedAmount),
    receivedAt: payment.receivedAt,
    status: payment.status,
    applications: payment.applications.map((application) => ({
      id: application.id,
      claimId: application.claimId,
      claimExternalId: application.claim.externalId,
      amount: Number(application.amount),
      appliedAt: application.appliedAt,
    })),
  }));
}

export async function findPaymentByExternalId(organizationId: string, externalId: string) {
  const payment = await db.payment.findUnique({ where: { organizationId_externalId: { organizationId, externalId } } });
  if (!payment) throw new NotFoundError("Payment not found");
  return payment;
}
