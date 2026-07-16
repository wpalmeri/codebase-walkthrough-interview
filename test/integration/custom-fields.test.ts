import { db } from "../../src/lib/db.js";
import { loadContext } from "../../src/permissions/context-loader.js";
import { defineCustomField, setCustomFieldValue, getEntityFields } from "../../src/custom-fields/custom-field-service.js";

describe("custom fields (EAV)", () => {
  it("strands a value in the string column when a definition changes type", async () => {
    const context = await loadContext("user_admin");
    // Seed already has fall_risk_score defined NUMBER, with patient_003 holding
    // a stringValue written under an earlier STRING definition.
    const fields = await getEntityFields(context, "Patient", "patient_003");
    expect("fall_risk_score" in fields.fields).toBe(true);
  });

  it("reads and writes typed values per entity", async () => {
    const context = await loadContext("user_admin");
    await defineCustomField(context, { entityType: "Patient", key: "test_field", label: "Test", dataType: "NUMBER" });
    await setCustomFieldValue(context, "Patient", "patient_001", "test_field", 42);
    const fields = await getEntityFields(context, "Patient", "patient_001");
    expect(fields.fields.test_field).toBe(42);

    const definition = await db.customFieldDefinition.findFirstOrThrow({ where: { organizationId: "org_northstar", key: "test_field" } });
    await db.customFieldValue.deleteMany({ where: { definitionId: definition.id } });
    await db.customFieldDefinition.delete({ where: { id: definition.id } });
  });
});
