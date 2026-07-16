import { createHash } from "node:crypto";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_NOTE_AMENDED, EVENT_NOTE_SIGNED } from "../events/event-names.js";
import { recomputeGroupDocumentationStatus } from "./completeness-service.js";

export async function createNote(context: RequestContext, visitId: string, content: object, templateId?: string) {
  const visit = await db.visit.findUnique({ where: { id: visitId } });
  if (!visit) throw new NotFoundError("Visit not found");
  return db.clinicalNote.create({
    data: { visitId, authorId: context.userId, content: asJson(content), templateId },
  });
}

/**
 * Signing writes signedAt/signedBy on the note AND a NoteSignature row with a
 * content hash. Both persist independently; nothing verifies the hash on
 * later reads, and the edit path below changes content without touching
 * either record.
 */
export async function signNote(context: RequestContext, noteId: string) {
  const note = await db.clinicalNote.findUniqueOrThrow({ where: { id: noteId } });
  const signedAt = new Date();
  const hash = createHash("sha256").update(JSON.stringify(note.content)).digest("hex");
  await db.noteSignature.create({ data: { noteId, userId: context.userId, contentHash: hash, signedAt } });
  const signed = await db.clinicalNote.update({ where: { id: noteId }, data: { status: "SIGNED", signedAt, signedBy: context.userId } });
  const visit = await db.visit.findUniqueOrThrow({ include: { visitGroup: { include: { visitSet: true } } }, where: { id: note.visitId } });
  await recomputeGroupDocumentationStatus(visit.visitGroupId);
  await db.auditEvent.create({
    data: {
      organizationId: visit.visitGroup.visitSet.organizationId,
      actorId: context.userId,
      action: "note.signed",
      resourceType: "ClinicalNote",
      resourceId: noteId,
    },
  });
  await emitDomainEvent({
    organizationId: visit.visitGroup.visitSet.organizationId,
    eventName: EVENT_NOTE_SIGNED,
    aggregateType: "ClinicalNote",
    aggregateId: noteId,
    payload: { noteId, visitId: note.visitId, signedBy: context.userId },
    emittedBy: context.userId,
  });
  return signed;
}

/**
 * The standard edit path. It does not check note status: signed notes are
 * edited in place, the stored signature hash silently stops matching the
 * content, and unlike signing there is no audit event here.
 */
export async function editNote(context: RequestContext, noteId: string, content: object) {
  return db.clinicalNote.update({
    where: { id: noteId },
    data: { content: asJson(content), version: { increment: 1 } },
  });
}

/**
 * Formal amendment. Records prior content on the amendment row, then
 * overwrites the note's current content — the note body no longer shows what
 * was signed, and only the amendment trail can reconstruct it.
 */
export async function amendNote(context: RequestContext, noteId: string, reason: string, content: object) {
  const note = await db.clinicalNote.findUniqueOrThrow({ where: { id: noteId } });
  await db.noteAmendment.create({
    data: { noteId, reason, priorContent: note.content ?? undefined, newContent: asJson(content), amendedBy: context.userId },
  });
  const updated = await db.clinicalNote.update({
    where: { id: noteId },
    data: { content: asJson(content), version: { increment: 1 } },
  });
  const visit = await db.visit.findUniqueOrThrow({ include: { visitGroup: { include: { visitSet: true } } }, where: { id: note.visitId } });
  await emitDomainEvent({
    organizationId: visit.visitGroup.visitSet.organizationId,
    eventName: EVENT_NOTE_AMENDED,
    aggregateType: "ClinicalNote",
    aggregateId: noteId,
    payload: { noteId, reason },
    emittedBy: context.userId,
  });
  return updated;
}

export async function noteWithHistory(noteId: string) {
  const note = await db.clinicalNote.findUnique({
    where: { id: noteId },
    include: { signatures: { orderBy: { signedAt: "asc" } }, amendments: { orderBy: { amendedAt: "asc" } } },
  });
  if (!note) throw new NotFoundError("Note not found");
  const currentHash = createHash("sha256").update(JSON.stringify(note.content)).digest("hex");
  return {
    note,
    integrity: note.signatures.map((signature) => ({
      signatureId: signature.id,
      signedAt: signature.signedAt,
      hashMatchesCurrentContent: signature.contentHash === currentHash,
    })),
  };
}
