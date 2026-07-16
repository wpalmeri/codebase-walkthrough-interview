import { TaskStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";
import { moduleLogger } from "../lib/logger.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { deliverToEndpoint } from "../integrations/webhook-dispatcher.js";

const log = moduleLogger("workflow-actions");

export interface WorkflowAction {
  type: string;
  url?: string;
  secret?: string;
  message?: string;
  title?: string;
  assigneeId?: string;
  queue?: string;
  priority?: string;
  eventName?: string;
  recordType?: string;
  retry?: string;
}

/**
 * Executes a single workflow action against an event payload.
 *
 * Notes on current behavior:
 *  - webhook actions POST inline with fetch; the secret is placed in a header
 *    in plaintext and not used to sign the body.
 *  - create_task/notify_supervisor derive organization from the payload; if
 *    the payload lacks organizationId the task is created with an empty
 *    string (workflows are supposed to be tenant-scoped but the payload
 *    shape isn't enforced).
 *  - emit can re-emit an event that re-triggers this same workflow; the only
 *    guard is the runner's depth check.
 */
export async function performAction(action: WorkflowAction, payload: Record<string, unknown>): Promise<unknown> {
  const organizationId = String(payload.organizationId ?? "");
  switch (action.type) {
    case "webhook": {
      if (!action.url) return { skipped: true, reason: "no url" };
      const response = await fetch(action.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-workflow-secret": action.secret ?? "" },
        body: JSON.stringify(payload),
      });
      return { status: response.status };
    }
    case "update_crm": {
      return deliverToEndpoint({ url: "http://localhost:3000/simulators/crm", secret: action.secret ?? "" }, "workflow.crm", {
        recordType: action.recordType,
        ...payload,
      });
    }
    case "create_task":
    case "notify_supervisor": {
      return db.taskRecord.create({
        data: {
          organizationId,
          title: action.title ?? action.message ?? "Workflow task",
          status: TaskStatus.OPEN,
          priority: action.type === "notify_supervisor" ? "HIGH" : action.priority ?? "NORMAL",
          assigneeId: action.assigneeId,
          patientId: typeof payload.patientId === "string" ? payload.patientId : undefined,
          visitId: typeof payload.visitId === "string" ? payload.visitId : undefined,
          claimId: typeof payload.claimId === "string" ? payload.claimId : undefined,
          source: "WORKFLOW",
        },
      });
    }
    case "require_review": {
      return db.taskRecord.create({
        data: { organizationId, title: "Finance review required", status: TaskStatus.OPEN, priority: "HIGH", source: "WORKFLOW", claimId: typeof payload.claimId === "string" ? payload.claimId : undefined },
      });
    }
    case "emit": {
      if (!action.eventName) return { skipped: true };
      return emitDomainEvent({
        organizationId,
        eventName: action.eventName,
        aggregateType: "Workflow",
        aggregateId: String(payload.id ?? payload.visitId ?? "unknown"),
        payload,
      });
    }
    case "audit": {
      return db.auditEvent.create({
        data: { organizationId, actorId: "workflow", action: "workflow.note", resourceType: "Workflow", resourceId: String(payload.id ?? "unknown"), payload: asJson({ message: action.message }) },
      });
    }
    default:
      log.warn({ type: action.type }, "unknown workflow action type; skipping");
      return { skipped: true, unknownType: action.type };
  }
}
