import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";

export interface TemplateField {
  key: string;
  label: string;
  type: "text" | "longtext" | "number" | "select" | "checkbox";
  required?: boolean;
  options?: string[];
}

export async function listTemplates(context: RequestContext, serviceType?: string) {
  return db.noteTemplate.findMany({
    where: { organizationId: context.organizationId, active: true, serviceType: serviceType ?? undefined },
    orderBy: { name: "asc" },
  });
}

/**
 * Updates a template's field schema in place, bumping `version` on the same
 * row. Notes written under earlier versions keep their content keyed by the
 * old field list; rendering resolves against whatever the template says
 * *today*, so removed fields disappear from historical notes.
 */
export async function updateTemplateSchema(context: RequestContext, templateId: string, fields: TemplateField[]) {
  const template = await db.noteTemplate.findFirst({ where: { id: templateId, organizationId: context.organizationId } });
  if (!template) throw new NotFoundError("Template not found");
  return db.noteTemplate.update({
    where: { id: templateId },
    data: { schema: asJson({ fields }), version: template.version + 1 },
  });
}

export async function renderNoteAgainstTemplate(noteId: string) {
  const note = await db.clinicalNote.findUniqueOrThrow({ where: { id: noteId } });
  if (!note.templateId) return { fields: [], content: note.content, orphanedKeys: [] };
  const template = await db.noteTemplate.findUnique({ where: { id: note.templateId } });
  if (!template) return { fields: [], content: note.content, orphanedKeys: Object.keys(note.content as object) };

  const schema = template.schema as { fields?: TemplateField[] };
  const fields = schema.fields ?? [];
  const content = note.content as Record<string, unknown>;
  const known = new Set(fields.map((field) => field.key));
  return {
    templateVersion: template.version,
    fields: fields.map((field) => ({ ...field, value: content[field.key] ?? null })),
    orphanedKeys: Object.keys(content).filter((key) => !known.has(key)),
    content,
  };
}
