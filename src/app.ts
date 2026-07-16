import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerUiRoutes } from "./ui/ui-routes.js";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError, UnprocessableError } from "./lib/errors.js";
import { registerIntakeRoutes } from "./http/routes/intake-routes.js";
import { registerPatientRoutes } from "./http/routes/patient-routes.js";
import { registerVisitRoutes } from "./http/routes/visit-routes.js";
import { registerRevenueRoutes } from "./http/routes/revenue-routes.js";
import { registerAccountingRoutes } from "./http/routes/accounting-routes.js";
import { registerReportingRoutes } from "./http/routes/reporting-routes.js";
import { registerPlatformRoutes } from "./http/routes/platform-routes.js";
import { registerAiRoutes } from "./http/routes/ai-routes.js";
import { registerAdminRoutes } from "./http/routes/admin-routes.js";
import { registerSimulatorRoutes } from "./http/routes/simulator-routes.js";
import { registerJobHandlers } from "./jobs/handlers.js";

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Midmarket EHR API",
        version: "1.0.0",
        description: "Intake, documentation, revenue cycle, accounting, reporting, workflows, and AI employee for a mid-market healthcare operations platform.",
      },
      tags: [
        { name: "intake" },
        { name: "patients" },
        { name: "visits" },
        { name: "revenue-cycle" },
        { name: "accounting" },
        { name: "reporting" },
        { name: "workflows" },
        { name: "ai-employee" },
        { name: "admin" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await registerUiRoutes(app);

  app.setErrorHandler((error: Error, request, reply) => {
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof ForbiddenError) return reply.code(403).send({ error: error.message });
    if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    if (error instanceof UnprocessableError) return reply.code(422).send({ error: error.message, details: error.details });
    request.log.error(error);
    return reply.code(500).send({ error: error.message });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready", time: new Date().toISOString() }));

  await registerIntakeRoutes(app);
  await registerPatientRoutes(app);
  await registerVisitRoutes(app);
  await registerRevenueRoutes(app);
  await registerAccountingRoutes(app);
  await registerReportingRoutes(app);
  await registerPlatformRoutes(app);
  await registerAiRoutes(app);
  await registerAdminRoutes(app);
  await registerSimulatorRoutes(app);

  registerJobHandlers();
  return app;
}
