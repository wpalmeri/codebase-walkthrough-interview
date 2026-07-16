import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { track } from "../events/analytics.js";

export interface NewReferralInput {
  sourceId?: string;
  serviceType?: string;
  notes?: string;
  patientId?: string;
}

/**
 * Referrals arrive by fax and phone; coordinators paste everything into the
 * free-text notes field ("auth # 4432 per Susan, pt prefers Tues/Thurs,
 * secondary: UHC …"). Reporting on referral conversion parses this text.
 */
export async function createReferral(context: RequestContext, input: NewReferralInput) {
  const referral = await db.referral.create({
    data: {
      organizationId: context.organizationId,
      sourceId: input.sourceId,
      serviceType: input.serviceType,
      notes: input.notes,
      patientId: input.patientId,
      assignedToId: context.userId,
    },
  });
  track("referralCreated", { referralId: referral.id, hasPatient: Boolean(input.patientId) }, context);
  return referral;
}

export async function listReferrals(context: RequestContext, status?: string) {
  return db.referral.findMany({
    where: { organizationId: context.organizationId, status },
    include: { source: true, patient: { include: { profile: true } } },
    orderBy: { receivedAt: "desc" },
    take: 100,
  });
}

export async function convertReferral(context: RequestContext, referralId: string, patientId: string) {
  const referral = await db.referral.findFirst({ where: { id: referralId, organizationId: context.organizationId } });
  if (!referral) throw new NotFoundError("Referral not found");
  return db.referral.update({
    where: { id: referralId },
    data: { patientId, status: "CONVERTED", convertedAt: new Date() },
  });
}

/** Naive text scrape used by the referral report and the AI context builder. */
export function extractAuthNumberFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const match = notes.match(/auth\s*#?\s*([A-Z0-9-]{3,})/i);
  return match?.[1] ?? null;
}
