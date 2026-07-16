import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function exists(path: string): Promise<boolean> {
  try {
    await access(root + path);
    return true;
  } catch {
    return false;
  }
}

describe("candidate packaging", () => {
  it("excludes internal interview material from the candidate archive", async () => {
    const script = await readFile(root + "scripts/package-candidate.sh", "utf8");
    expect(script).toContain("INTERNAL_INTERVIEW_GUIDE.md");
    expect(script).toContain("IMPLEMENTATION_PLAN.md");
    expect(script).toMatch(/--exclude=.*INTERNAL_INTERVIEW_GUIDE\.md/);
    expect(script).toMatch(/--exclude=.*IMPLEMENTATION_PLAN\.md/);
  });

  it("keeps the candidate-facing document and UI assets available", async () => {
    // These ship in the candidate package and must always be present.
    expect(await exists("EXTERNAL_INTERVIEW.md")).toBe(true);
    expect(await exists("public/index.html")).toBe(true);
    expect(await exists("public/app.css")).toBe(true);
    expect(await exists("public/app.js")).toBe(true);
  });

  it("names both internal documents in the package exclusion list", async () => {
    // The internal documents live at the repo root in the full working copy and
    // are stripped by the package script, so they are absent from the extracted
    // candidate package. Rather than assert their presence (which does not hold
    // in the distributed archive), confirm the script is configured to drop
    // them.
    const script = await readFile(root + "scripts/package-candidate.sh", "utf8");
    for (const internal of ["INTERNAL_INTERVIEW_GUIDE.md", "IMPLEMENTATION_PLAN.md"]) {
      expect(script).toContain(internal);
    }
  });
});
