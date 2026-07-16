import { db } from "../../src/lib/db.js";
import { editNote } from "../../src/documentation/note-service.js";
import { loadContext } from "../../src/permissions/context-loader.js";

describe("clinical documentation compatibility", () => {
  it("allows a signed note to be edited through the legacy edit path", async () => {
    const context = await loadContext("user_clinician_sf");
    const note = await db.clinicalNote.findUniqueOrThrow({ where: { id: "note_1_0_0" } });
    const original = note.content;
    const edited = await editNote(context, note.id, { changedAfterSigning: true });
    expect(edited.status).toBe("SIGNED");
    expect(edited.version).toBe(note.version + 1);
    await db.clinicalNote.update({ where: { id: note.id }, data: { content: original!, version: note.version } });
  });
});
