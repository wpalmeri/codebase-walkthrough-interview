import type { FastifyInstance, FastifyRequest } from "fastify";
import type { VisitStatus } from "@prisma/client";
import { contextFor } from "../request-context.js";
import { listVisits, recentVisitActivity } from "../../visits/visit-list.js";
import { getVisitResponse } from "../../visits/visit-read-service.js";
import { visitDetail } from "../../visits/visit-detail.js";
import { completeVisit, scheduleVisit, startVisit, markNoShow, authorizationUsage } from "../../visits/visit-service.js";
import { scheduleVisitChecked, rescheduleVisit, cancelVisit, moveVisitBranch } from "../../scheduling/schedule-service.js";
import { weekCalendar } from "../../scheduling/calendar.js";
import { branchCapacitySummary } from "../../scheduling/capacity.js";
import { authorizationSummary } from "../../orders/authorization-service.js";
import { createNote, signNote, editNote, amendNote, noteWithHistory } from "../../documentation/note-service.js";
import { documentationBacklogRows, setDocumentationSummary } from "../../documentation/completeness-service.js";
import { renderNoteAgainstTemplate, listTemplates } from "../../documentation/note-templates.js";

function toDate(value: unknown): Date {
  return new Date(String(value));
}

export async function registerVisitRoutes(app: FastifyInstance): Promise<void> {
  app.get("/visits", async (request: FastifyRequest) => {
    const query = request.query as Record<string, string | undefined>;
    return listVisits(await contextFor(request), Number(query.page ?? 1), Number(query.pageSize ?? 25), {
      status: query.status as VisitStatus | undefined,
      branchId: query.branchId,
      patientId: query.patientId,
      clinicianId: query.clinicianId,
      serviceType: query.serviceType,
      documentationStatus: query.documentationStatus,
      from: query.from ? toDate(query.from) : undefined,
      to: query.to ? toDate(query.to) : undefined,
    });
  });
  app.get("/visits/recent", async (request) => recentVisitActivity(await contextFor(request), Number((request.query as { limit?: string }).limit ?? 12)));
  app.get("/visits/:id", async (request) => getVisitResponse((request.params as { id: string }).id));
  app.get("/visits/:id/detail", async (request) => visitDetail((request.params as { id: string }).id));

  app.post("/visits", async (request) => {
    const input = request.body as { visitSetId: string; branchId: string; clinicianId: string; start: string; durationMinutes: number };
    return scheduleVisit(await contextFor(request), { ...input, start: toDate(input.start) });
  });
  app.post("/visits/checked", async (request) => {
    const input = request.body as { visitSetId: string; branchId: string; clinicianId: string; start: string; durationMinutes: number; locationId?: string };
    return scheduleVisitChecked(await contextFor(request), { ...input, start: toDate(input.start) });
  });
  app.post("/visits/:id/complete", async (request) => {
    const input = request.body as { actualStart: string; actualEnd: string };
    return completeVisit(await contextFor(request), (request.params as { id: string }).id, toDate(input.actualStart), toDate(input.actualEnd));
  });
  app.post("/visits/:id/start", async (request) => startVisit(await contextFor(request), (request.params as { id: string }).id));
  app.post("/visits/:id/no-show", async (request) => markNoShow(await contextFor(request), (request.params as { id: string }).id));
  app.post("/visits/:id/reschedule", async (request) => {
    const input = request.body as { start: string; durationMinutes: number };
    return rescheduleVisit(await contextFor(request), (request.params as { id: string }).id, toDate(input.start), input.durationMinutes);
  });
  app.post("/visits/:id/cancel", async (request) => {
    const input = request.body as { reason: string };
    return cancelVisit(await contextFor(request), (request.params as { id: string }).id, input.reason);
  });
  app.post("/visits/:id/move-branch", async (request) => {
    const input = request.body as { branchId: string };
    return moveVisitBranch(await contextFor(request), (request.params as { id: string }).id, input.branchId);
  });

  app.get("/visit-sets/:id/authorization-usage", async (request) => authorizationUsage((request.params as { id: string }).id));
  app.get("/visit-sets/:id/authorization", async (request) => authorizationSummary((request.params as { id: string }).id));
  app.get("/visit-sets/:id/documentation", async (request) => setDocumentationSummary((request.params as { id: string }).id));

  app.get("/calendar", async (request) => {
    const query = request.query as { branchId: string; weekStart: string };
    return weekCalendar(await contextFor(request), query.branchId, toDate(query.weekStart));
  });
  app.get("/branches/:id/capacity", async (request) => {
    const query = request.query as { date?: string };
    return branchCapacitySummary(await contextFor(request), (request.params as { id: string }).id, query.date ? toDate(query.date) : new Date());
  });

  app.post("/notes", async (request) => {
    const input = request.body as { visitId: string; content: object; templateId?: string };
    return createNote(await contextFor(request), input.visitId, input.content, input.templateId);
  });
  app.post("/notes/:id/sign", async (request) => signNote(await contextFor(request), (request.params as { id: string }).id));
  app.put("/notes/:id", async (request) => {
    const input = request.body as { content: object };
    return editNote(await contextFor(request), (request.params as { id: string }).id, input.content);
  });
  app.post("/notes/:id/amend", async (request) => {
    const input = request.body as { reason: string; content: object };
    return amendNote(await contextFor(request), (request.params as { id: string }).id, input.reason, input.content);
  });
  app.get("/notes/:id", async (request) => noteWithHistory((request.params as { id: string }).id));
  app.get("/notes/:id/render", async (request) => renderNoteAgainstTemplate((request.params as { id: string }).id));
  app.get("/note-templates", async (request) => listTemplates(await contextFor(request), (request.query as { serviceType?: string }).serviceType));

  app.get("/documentation/backlog", async (request) => {
    const context = await contextFor(request);
    return documentationBacklogRows(context.organizationId, Number((request.query as { limit?: string }).limit ?? 100));
  });
}
