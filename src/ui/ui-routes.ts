import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  dashboardData,
  dashboardExceptions,
  organizationList,
  patientDirectory,
  patientDetail,
  visitList,
  visitDrawer,
  documentationBacklog,
  claimsQueue,
  rejections,
  accountingOverview,
  monthCloseDetail,
  reportsOverview,
  automationOverview,
  aiWorkspace,
  permissionsView,
  tasksView,
} from "./ui-data.js";
import { askOperations, executeProposedAction } from "../ai-employee/operations-agent.js";
import { runReportByKey } from "../reporting/run-report.js";
import { loadContext } from "../permissions/context-loader.js";

const indexPath = fileURLToPath(new URL("../../public/index.html", import.meta.url));
const cssPath = fileURLToPath(new URL("../../public/app.css", import.meta.url));
const jsPath = fileURLToPath(new URL("../../public/app.js", import.meta.url));

function org(request: { query: unknown }): string {
  return (request.query as { organizationId?: string }).organizationId ?? "org_northstar";
}

export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await readFile(indexPath)));
  app.get("/ui/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "no-cache").send(await readFile(cssPath)));
  app.get("/ui/app.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").header("cache-control", "no-cache").send(await readFile(jsPath)));

  // Contract preserved for test/integration/ui.test.ts.
  app.get("/ui-api/dashboard", async (request) => dashboardData(org(request)));
  app.get("/ui-api/patients", async (request) => { const query = request.query as { organizationId?: string; q?: string }; return patientDirectory(query.organizationId ?? "org_northstar", query.q ?? ""); });
  app.get("/ui-api/claims", async (request) => claimsQueue(org(request)));
  app.get("/ui-api/accounting", async (request) => accountingOverview(org(request)));
  app.get("/ui-api/automations", async (request) => automationOverview(org(request)));

  // Expanded workspace endpoints.
  app.get("/ui-api/orgs", async () => organizationList());
  app.get("/ui-api/dashboard/exceptions", async (request) => dashboardExceptions(org(request)));
  app.get("/ui-api/patients/:id", async (request) => patientDetail((request.params as { id: string }).id));
  app.get("/ui-api/visits", async (request) => {
    const query = request.query as { organizationId?: string; status?: string; branchId?: string; q?: string };
    return visitList(query.organizationId ?? "org_northstar", { status: query.status, branchId: query.branchId, q: query.q });
  });
  app.get("/ui-api/visits/:id", async (request) => visitDrawer((request.params as { id: string }).id));
  app.get("/ui-api/documentation", async (request) => documentationBacklog(org(request)));
  app.get("/ui-api/rejections", async (request) => rejections(org(request)));
  app.get("/ui-api/month-close", async (request) => {
    const query = request.query as { organizationId?: string; periodId?: string };
    return monthCloseDetail(query.organizationId ?? "org_northstar", query.periodId);
  });
  app.get("/ui-api/reports", async (request) => reportsOverview(org(request)));
  app.post("/ui-api/reports/run", async (request) => {
    const body = request.body as { organizationId?: string; key: string; params?: Record<string, string> };
    const context = await loadContext(body.organizationId === "org_evergreen" ? "ev_user_admin" : body.organizationId === "org_lakeside" ? "user_lakeside" : "user_admin");
    return runReportByKey(context, body.key, body.params ?? {});
  });
  app.get("/ui-api/ai", async (request) => aiWorkspace(org(request)));
  app.post("/ui-api/ai/ask", async (request) => {
    const body = request.body as { organizationId?: string; question: string };
    const organizationId = body.organizationId ?? "org_northstar";
    const actor = organizationId === "org_evergreen" ? "ev_user_admin" : organizationId === "org_lakeside" ? "user_lakeside" : "user_admin";
    return askOperations(organizationId, actor, body.question);
  });
  app.post("/ui-api/ai/actions/:id/execute", async (request) => executeProposedAction((request.params as { id: string }).id));
  app.get("/ui-api/permissions", async () => permissionsView());
  app.get("/ui-api/tasks", async (request) => tasksView(org(request)));
}
