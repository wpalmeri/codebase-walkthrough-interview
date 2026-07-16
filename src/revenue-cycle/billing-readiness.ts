import { db } from "../lib/db.js";

export async function billingReadiness(visitId: string) {
  const visit = await db.visit.findUniqueOrThrow({ include: { notes: true, visitGroup: { include: { visitSet: { include: { authorization: true } } } } }, where: { id: visitId } });
  const siblingVisits = await db.visit.count({ where: { visitGroup: { visitSetId: visit.visitGroup.visitSetId }, status: "COMPLETED" } });
  const signed = visit.notes.some((note) => note.status === "SIGNED");
  return {
    ready: visit.status === "COMPLETED" && signed && visit.visitGroup.billingStatus !== "BLOCKED",
    reasons: [!signed ? "UNSIGNED_NOTE" : null, siblingVisits > (visit.visitGroup.visitSet.authorization?.maxVisits ?? Infinity) ? "AUTH_LIMIT" : null].filter(Boolean),
    siblingVisits,
  };
}
