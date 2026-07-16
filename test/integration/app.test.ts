import { buildApp } from "../../src/app.js";
import { db } from "../../src/lib/db.js";

describe("HTTP application", () => {
  const appPromise = buildApp();

  afterAll(async () => {
    const app = await appPromise;
    await app.close();
  });

  it("provides a health check without external services", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("loads a representative order through the full hierarchy", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/orders/order_0" });
    expect(response.statusCode).toBe(200);
    expect(response.json().visitCount).toBe(5);
    expect(response.json().order.visitSets[0].groups).toHaveLength(3);
  });

  it("returns visit list data for an administrator", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/visits?userId=user_admin&pageSize=5" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(5);
    expect(response.json().total).toBeGreaterThan(36);
  });

  it("applies branch checks after fetching the page", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/visits?userId=user_viewer&pageSize=20" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.every((visit: { visitGroup: { branchId: string } }) => visit.visitGroup.branchId === "branch_oak")).toBe(true);
    expect(response.json().total).toBeGreaterThan(response.json().data.length);
  });

  it("exposes generated API documentation", async () => {
    const response = await (await appPromise).inject({ method: "GET", url: "/docs/json" });
    expect(response.statusCode).toBe(200);
  });

  it("can query seeded database directly", async () => {
    await expect(db.organization.count()).resolves.toBe(3);
  });
});
