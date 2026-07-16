import { TaskStatus } from "@prisma/client";
import { db } from "../lib/db.js";
import type { RequestContext } from "../lib/context.js";
import { NotFoundError } from "../lib/errors.js";
import { emitDomainEvent } from "../events/domain-events.js";
import { EVENT_TASK_CREATED } from "../events/event-names.js";

export interface NewTaskInput {
  title: string;
  description?: string;
  priority?: string;
  assigneeId?: string;
  patientId?: string;
  visitId?: string;
  claimId?: string;
  dueAt?: Date;
}

export async function createTask(context: RequestContext, input: NewTaskInput) {
  const task = await db.taskRecord.create({
    data: {
      organizationId: context.organizationId,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "NORMAL",
      assigneeId: input.assigneeId,
      patientId: input.patientId,
      visitId: input.visitId,
      claimId: input.claimId,
      dueAt: input.dueAt,
      source: "MANUAL",
      createdBy: context.userId,
    },
  });
  await emitDomainEvent({
    organizationId: context.organizationId,
    eventName: EVENT_TASK_CREATED,
    aggregateType: "TaskRecord",
    aggregateId: task.id,
    payload: { taskId: task.id, title: task.title },
    emittedBy: context.userId,
  });
  return task;
}

export async function taskQueue(context: RequestContext, filters: { status?: TaskStatus; assigneeId?: string } = {}) {
  return db.taskRecord.findMany({
    where: { organizationId: context.organizationId, status: filters.status, assigneeId: filters.assigneeId },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 200,
  });
}

export async function completeTask(context: RequestContext, taskId: string) {
  const task = await db.taskRecord.findFirst({ where: { id: taskId, organizationId: context.organizationId } });
  if (!task) throw new NotFoundError("Task not found");
  return db.taskRecord.update({ where: { id: taskId }, data: { status: TaskStatus.COMPLETED, completedAt: new Date() } });
}

export async function taskCounts(context: RequestContext) {
  const open = await db.taskRecord.count({ where: { organizationId: context.organizationId, status: TaskStatus.OPEN } });
  const inProgress = await db.taskRecord.count({ where: { organizationId: context.organizationId, status: TaskStatus.IN_PROGRESS } });
  const overdue = await db.taskRecord.count({
    where: { organizationId: context.organizationId, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }, dueAt: { lt: new Date() } },
  });
  return { open, inProgress, overdue };
}
