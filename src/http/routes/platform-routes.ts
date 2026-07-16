import type { FastifyInstance } from "fastify";
import type { TaskStatus } from "@prisma/client";
import { contextFor } from "../request-context.js";
import { saveWorkflow, listWorkflows, toggleWorkflow, workflowExecutions, recentExecutions } from "../../workflows/workflow-service.js";
import { processPendingEvents } from "../../workflows/workflow-runner.js";
import { ACTION_CATALOG } from "../../workflows/action-catalog.js";
import { createWebhookEndpoint, listWebhookEndpoints, recentDeliveries, toggleWebhookEndpoint } from "../../integrations/webhook-service.js";
import { defineCustomField, listDefinitions, setCustomFieldValue, getEntityFields } from "../../custom-fields/custom-field-service.js";
import { globalSearch } from "../../search/global-search.js";
import { createTask, taskQueue, completeTask, taskCounts } from "../../tasks/task-service.js";

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workflows", async (request) => listWorkflows(await contextFor(request)));
  app.get("/workflows/actions", async () => ACTION_CATALOG);
  app.post("/workflows", async (request) => saveWorkflow(await contextFor(request), request.body as never));
  app.put("/workflows/:id", async (request) => saveWorkflow(await contextFor(request), request.body as never, (request.params as { id: string }).id));
  app.post("/workflows/:id/toggle", async (request) => {
    const input = request.body as { enabled: boolean };
    return toggleWorkflow(await contextFor(request), (request.params as { id: string }).id, input.enabled);
  });
  app.get("/workflows/:id/executions", async (request) => workflowExecutions(await contextFor(request), (request.params as { id: string }).id));
  app.get("/workflow-executions", async (request) => recentExecutions(await contextFor(request)));
  app.post("/jobs/process-events", async () => processPendingEvents());

  app.get("/webhooks", async (request) => listWebhookEndpoints(await contextFor(request)));
  app.post("/webhooks", async (request) => {
    const input = request.body as { url: string; eventNames: string[] };
    return createWebhookEndpoint(await contextFor(request), input.url, input.eventNames);
  });
  app.post("/webhooks/:id/toggle", async (request) => {
    const input = request.body as { active: boolean };
    return toggleWebhookEndpoint(await contextFor(request), (request.params as { id: string }).id, input.active);
  });
  app.get("/webhook-deliveries", async (request) => recentDeliveries(await contextFor(request)));

  app.get("/custom-fields", async (request) => listDefinitions(await contextFor(request), (request.query as { entityType?: string }).entityType));
  app.post("/custom-fields", async (request) => defineCustomField(await contextFor(request), request.body as never));
  app.post("/custom-fields/values", async (request) => {
    const input = request.body as { entityType: string; entityId: string; key: string; value: unknown };
    return setCustomFieldValue(await contextFor(request), input.entityType, input.entityId, input.key, input.value);
  });
  app.get("/custom-fields/:entityType/:entityId", async (request) => {
    const params = request.params as { entityType: string; entityId: string };
    return getEntityFields(await contextFor(request), params.entityType, params.entityId);
  });

  app.get("/search", async (request) => {
    const query = request.query as { q: string; limit?: string };
    return globalSearch(await contextFor(request), query.q ?? "", Number(query.limit ?? 8));
  });

  app.get("/tasks", async (request) => {
    const query = request.query as { status?: string; assigneeId?: string };
    return taskQueue(await contextFor(request), { status: query.status as TaskStatus | undefined, assigneeId: query.assigneeId });
  });
  app.get("/tasks/counts", async (request) => taskCounts(await contextFor(request)));
  app.post("/tasks", async (request) => createTask(await contextFor(request), request.body as never));
  app.post("/tasks/:id/complete", async (request) => completeTask(await contextFor(request), (request.params as { id: string }).id));
}
