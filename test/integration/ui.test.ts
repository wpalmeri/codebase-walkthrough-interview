import { buildApp } from "../../src/app.js";

describe("browser application", () => {
  const appPromise = buildApp();

  afterAll(async () => {
    await (await appPromise).close();
  });

  it("serves the EHR application at the root URL", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Juniper Health");
    expect(response.body).toContain("AI employee");
    expect(response.body).toContain("Revenue cycle");
  });

  it("serves version-independent UI assets", async () => {
    const [css, javascript] = await Promise.all([
      (await appPromise).inject({ method: "GET", url: "/ui/app.css" }),
      (await appPromise).inject({ method: "GET", url: "/ui/app.js" }),
    ]);
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).toContain(".app-shell");
    expect(javascript.statusCode).toBe(200);
    expect(javascript.headers["content-type"]).toContain("application/javascript");
    expect(javascript.body).toContain("renderDashboard");
  });

  it("loads dashboard metrics from seeded operational data", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/ui-api/dashboard?organizationId=org_northstar" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metrics.activePatients).toBe(36);
    expect(body.metrics.claimCount).toBe(14);
    expect(body.metrics.expectedRevenue).toBeGreaterThan(1_000);
    expect(body.recentVisits.length).toBeGreaterThan(0);
  });

  it("loads searchable patient directory data", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/ui-api/patients?organizationId=org_northstar&q=Patient00" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({ id: "patient_000", payer: "Acme Health Plan" });
  });

  it("loads claims, accounting, and automation workspaces", async () => {
    const [claims, accounting, automations] = await Promise.all([
      (await appPromise).inject({ method: "GET", url: "/ui-api/claims?organizationId=org_northstar" }),
      (await appPromise).inject({ method: "GET", url: "/ui-api/accounting?organizationId=org_northstar" }),
      (await appPromise).inject({ method: "GET", url: "/ui-api/automations?organizationId=org_northstar" }),
    ]);
    expect(claims.json()).toHaveLength(14);
    expect(claims.json().some((claim: { status: string }) => claim.status === "REJECTED")).toBe(true);
    expect(accounting.json().periods).toHaveLength(2);
    expect(accounting.json().payments.length).toBeGreaterThan(0);
    expect(automations.json().workflows).toHaveLength(1);
  });
});
