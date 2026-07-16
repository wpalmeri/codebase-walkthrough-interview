import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";

/**
 * Duplicate-patient detection.
 *
 * Matching is exact on normalized name + date of birth, with a secondary
 * phone-only pass. There is no phonetic or fuzzy matching, no MRN check, and
 * nothing prevents two intake coordinators from creating the same patient in
 * parallel — the database has no uniqueness constraint to fall back on.
 */

export interface DuplicateCandidate {
  patientId: string;
  score: number;
  matchedOn: string[];
  displayName: string;
  dateOfBirth: string;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z]/g, "");
}

export async function findDuplicateCandidates(
  context: RequestContext,
  input: { firstName: string; lastName: string; dateOfBirth: Date; phone?: string | null },
): Promise<DuplicateCandidate[]> {
  const sameDob = await db.patient.findMany({
    where: { organizationId: context.organizationId, dateOfBirth: input.dateOfBirth, deletedAt: null },
    include: { profile: true },
  });

  const candidates: DuplicateCandidate[] = [];
  for (const patient of sameDob) {
    const matchedOn: string[] = ["dateOfBirth"];
    let score = 0.3;
    if (normalizeName(patient.firstName) === normalizeName(input.firstName)) {
      score += 0.3;
      matchedOn.push("firstName");
    }
    if (normalizeName(patient.lastName) === normalizeName(input.lastName)) {
      score += 0.3;
      matchedOn.push("lastName");
    }
    if (patient.profile?.preferredName && normalizeName(patient.profile.preferredName) === normalizeName(input.firstName)) {
      score += 0.2;
      matchedOn.push("preferredName");
    }
    if (score >= 0.6) {
      candidates.push({
        patientId: patient.id,
        score: Math.min(score, 0.99),
        matchedOn,
        displayName: `${patient.firstName} ${patient.lastName}`,
        dateOfBirth: patient.dateOfBirth.toISOString().slice(0, 10),
      });
    }
  }

  if (input.phone) {
    const byPhone = await db.patient.findMany({
      where: { organizationId: context.organizationId, phone: input.phone, deletedAt: null },
    });
    for (const patient of byPhone) {
      if (candidates.some((candidate) => candidate.patientId === patient.id)) continue;
      candidates.push({
        patientId: patient.id,
        score: 0.5,
        matchedOn: ["phone"],
        displayName: `${patient.firstName} ${patient.lastName}`,
        dateOfBirth: patient.dateOfBirth.toISOString().slice(0, 10),
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export async function recordPossibleMatches(newPatientId: string, candidates: DuplicateCandidate[]): Promise<void> {
  for (const candidate of candidates) {
    await db.possiblePatientMatch.create({
      data: { patientId: newPatientId, candidateId: candidate.patientId, score: candidate.score },
    });
  }
}

export async function pendingMatchQueue(context: RequestContext, limit = 50) {
  const matches = await db.possiblePatientMatch.findMany({
    where: { status: "PENDING" },
    orderBy: { score: "desc" },
    take: limit,
  });
  // Match rows do not carry an organization id; scope by resolving each patient.
  const scoped = [];
  for (const match of matches) {
    const patient = await db.patient.findUnique({ where: { id: match.patientId } });
    if (patient?.organizationId === context.organizationId) scoped.push({ match, patient });
  }
  return scoped;
}

export async function resolveMatch(context: RequestContext, matchId: string, resolution: "DISMISSED" | "CONFIRMED") {
  return db.possiblePatientMatch.update({
    where: { id: matchId },
    data: { status: resolution, reviewedBy: context.userId, reviewedAt: new Date() },
  });
}
