import { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { asJson } from "../lib/json.js";

/**
 * Custom fields (EAV).
 *
 * Definitions are per (organization, entityType, key). Values are stored one
 * row per (definition, entity) in CustomFieldValue with typed columns. Three
 * problems live here on purpose:
 *  - A definition's dataType and configuration can change after values are
 *    written; historical values keep whatever column they were stored in, so
 *    a STRING->NUMBER change strands old values in stringValue.
 *  - Reading an entity's fields is one query per entity (getEntityFields),
 *    and reporting joins these per row.
 *  - There is no referential integrity between CustomFieldValue.entityId and
 *    the target table; merges and deletes leave orphaned values.
 */

export interface CustomFieldDefinitionInput {
  entityType: string;
  key: string;
  label: string;
  dataType: "STRING" | "NUMBER" | "DATE" | "BOOLEAN" | "SELECT" | "JSON";
  configuration?: Record<string, unknown>;
}

export async function defineCustomField(context: RequestContext, input: CustomFieldDefinitionInput) {
  const existing = await db.customFieldDefinition.findUnique({
    where: { organizationId_entityType_key: { organizationId: context.organizationId, entityType: input.entityType, key: input.key } },
  });
  if (existing) {
    // In-place mutation; version bumps but stored values are not migrated.
    return db.customFieldDefinition.update({
      where: { id: existing.id },
      data: { label: input.label, dataType: input.dataType, configuration: asJson(input.configuration ?? {}), version: existing.version + 1, active: true },
    });
  }
  return db.customFieldDefinition.create({
    data: {
      organizationId: context.organizationId,
      entityType: input.entityType,
      key: input.key,
      label: input.label,
      dataType: input.dataType,
      configuration: asJson(input.configuration ?? {}),
    },
  });
}

export async function listDefinitions(context: RequestContext, entityType?: string) {
  return db.customFieldDefinition.findMany({
    where: { organizationId: context.organizationId, entityType, active: true },
    orderBy: [{ entityType: "asc" }, { key: "asc" }],
  });
}

export async function setCustomFieldValue(context: RequestContext, entityType: string, entityId: string, key: string, value: unknown) {
  const definition = await db.customFieldDefinition.findUnique({
    where: { organizationId_entityType_key: { organizationId: context.organizationId, entityType, key } },
  });
  if (!definition) throw new NotFoundError(`No custom field "${key}" for ${entityType}`);

  const data: Prisma.CustomFieldValueUncheckedCreateInput = { definitionId: definition.id, entityType, entityId };
  switch (definition.dataType) {
    case "NUMBER":
      data.numberValue = new Prisma.Decimal(String(value));
      break;
    case "DATE":
      data.dateValue = new Date(String(value));
      break;
    case "BOOLEAN":
      data.booleanValue = Boolean(value);
      break;
    case "JSON":
      data.jsonValue = asJson(value);
      break;
    default:
      data.stringValue = String(value);
  }

  // Upsert-by-hand: delete prior value rows for this (definition, entity),
  // then insert. A concurrent write can leave two rows.
  const existing = await db.customFieldValue.findFirst({ where: { definitionId: definition.id, entityId } });
  if (existing) {
    return db.customFieldValue.update({ where: { id: existing.id }, data: { ...data, updatedAt: new Date() } });
  }
  return db.customFieldValue.create({ data });
}

/** One query per entity; reporting calls this per row. */
export async function getEntityFields(context: RequestContext, entityType: string, entityId: string) {
  const values = await db.customFieldValue.findMany({
    where: { entityType, entityId, definition: { is: { organizationId: context.organizationId } } },
    include: { definition: true },
  });
  const fields: Record<string, unknown> = {};
  const orphaned: string[] = [];
  for (const value of values) {
    if (!value.definition?.active) {
      orphaned.push(value.id);
      continue;
    }
    fields[value.definition.key] =
      value.stringValue ??
      (value.numberValue !== null ? Number(value.numberValue) : undefined) ??
      value.dateValue ??
      value.booleanValue ??
      value.jsonValue ??
      null;
  }
  return { fields, orphanedValueIds: orphaned };
}
