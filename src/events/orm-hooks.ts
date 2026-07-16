import type { Prisma, Visit, ClinicalNote } from "@prisma/client";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";

/**
 * "Hook" wrappers that bundle side effects with writes. A previous attempt at
 * Prisma middleware was reverted after it double-wrote audit rows; these
 * wrappers are what remain. Some services call them, some write directly.
 */

export async function updateVisitWithHooks(
  visitId: string,
  data: Prisma.VisitUpdateInput,
  actor: { userId: string; organizationId: string },
): Promise<Visit> {
  const before = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
  const after = await db.visit.update({ where: { id: visitId }, data });
  await db.auditEvent.create({
    data: {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "visit.updated",
      resourceType: "Visit",
      resourceId: visitId,
      payload: asJson({ before: { status: before.status }, after: { status: after.status } }),
    },
  });
  if (before.status !== after.status) {
    await db.visitStatusHistory.create({
      data: { visitId, fromStatus: before.status, toStatus: after.status, changedBy: actor.userId },
    });
  }
  return after;
}

export async function updateNoteWithHooks(
  noteId: string,
  data: Prisma.ClinicalNoteUpdateInput,
  actor: { userId: string; organizationId: string },
): Promise<ClinicalNote> {
  const after = await db.clinicalNote.update({ where: { id: noteId }, data });
  await db.auditEvent.create({
    data: {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "note.updated",
      resourceType: "ClinicalNote",
      resourceId: noteId,
      payload: asJson({ version: after.version, status: after.status }),
    },
  });
  return after;
}
