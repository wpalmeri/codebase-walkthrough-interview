import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { ConflictError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";
import { autoApplyRemittanceLine } from "./cash-application.js";

/**
 * Remittance (835-style) import. Files arrive as JSON from the clearinghouse
 * simulator. Import is idempotent on (organization, externalId) at the file
 * level; line application below is not.
 */

export interface RemittancePayload {
  externalId: string;
  payerCode?: string;
  totalAmount: number;
  lines: Array<{
    claimExternalId?: string;
    patientLastName?: string;
    serviceDate?: string;
    billedAmount: number;
    paidAmount: number;
    adjustmentAmount?: number;
    adjustmentCode?: string;
  }>;
}

export async function importRemittanceFile(organizationId: string, payload: RemittancePayload) {
  const existing = await db.remittanceFile.findUnique({
    where: { organizationId_externalId: { organizationId, externalId: payload.externalId } },
  });
  if (existing) throw new ConflictError(`Remittance ${payload.externalId} already imported`);

  const payer = payload.payerCode ? await db.payer.findUnique({ where: { code: payload.payerCode } }) : null;

  return db.remittanceFile.create({
    data: {
      organizationId,
      externalId: payload.externalId,
      payerId: payer?.id,
      totalAmount: new Prisma.Decimal(payload.totalAmount.toFixed(2)),
      raw: asJson(payload),
      lines: {
        create: payload.lines.map((line) => ({
          claimExternalId: line.claimExternalId,
          patientLastName: line.patientLastName,
          serviceDate: line.serviceDate ? new Date(line.serviceDate) : null,
          billedAmount: new Prisma.Decimal(line.billedAmount.toFixed(2)),
          paidAmount: new Prisma.Decimal(line.paidAmount.toFixed(2)),
          adjustmentAmount: new Prisma.Decimal((line.adjustmentAmount ?? 0).toFixed(2)),
          adjustmentCode: line.adjustmentCode,
        })),
      },
    },
    include: { lines: true },
  });
}

export async function processRemittanceFile(fileId: string) {
  const file = await db.remittanceFile.findUniqueOrThrow({ where: { id: fileId }, include: { lines: true } });
  const results = [];
  for (const line of file.lines) {
    if (line.status === "APPLIED") continue;
    try {
      results.push(await autoApplyRemittanceLine(line.id));
    } catch (error) {
      results.push({ matched: false as const, remittanceLineId: line.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const matched = results.filter((result) => result.matched).length;
  await db.remittanceFile.update({
    where: { id: fileId },
    data: { status: matched === file.lines.length ? "APPLIED" : "PARTIALLY_APPLIED" },
  });
  return { fileId, total: file.lines.length, matched, results };
}

export async function listRemittanceFiles(organizationId: string) {
  return db.remittanceFile.findMany({
    where: { organizationId },
    include: { lines: true },
    orderBy: { receivedAt: "desc" },
    take: 25,
  });
}
