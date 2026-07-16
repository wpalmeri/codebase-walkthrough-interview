import { JobStatus, type JobRecord } from "@prisma/client";
import { db } from "../lib/db.js";
import { asJson } from "../lib/json.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("jobs");

export type JobHandler = (payload: Record<string, unknown>, job: JobRecord) => Promise<unknown>;

const registry = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  registry.set(type, handler);
}

export function registeredJobTypes(): string[] {
  return [...registry.keys()];
}

export async function enqueueJob(type: string, payload: Record<string, unknown>, options?: { runAt?: Date; maxAttempts?: number }) {
  return db.jobRecord.create({
    data: {
      type,
      payload: asJson(payload),
      runAt: options?.runAt ?? new Date(),
      maxAttempts: options?.maxAttempts ?? 5,
    },
  });
}

export async function claimNextJob(workerId: string): Promise<JobRecord | null> {
  const candidate = await db.jobRecord.findFirst({
    where: { status: JobStatus.PENDING, runAt: { lte: new Date() } },
    orderBy: { runAt: "asc" },
  });
  if (!candidate) return null;
  const claimed = await db.jobRecord.updateMany({
    where: { id: candidate.id, status: JobStatus.PENDING },
    data: { status: JobStatus.RUNNING, lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  return db.jobRecord.findUnique({ where: { id: candidate.id } });
}

export async function runJob(job: JobRecord): Promise<void> {
  const handler = registry.get(job.type);
  if (!handler) {
    await db.jobRecord.update({ where: { id: job.id }, data: { status: JobStatus.DEAD, lastError: `No handler for ${job.type}` } });
    return;
  }
  try {
    await handler((job.payload ?? {}) as Record<string, unknown>, job);
    await db.jobRecord.update({ where: { id: job.id }, data: { status: JobStatus.SUCCEEDED, completedAt: new Date() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = job.attempts >= job.maxAttempts;
    log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, dead, message }, "job failed");
    await db.jobRecord.update({
      where: { id: job.id },
      data: {
        status: dead ? JobStatus.DEAD : JobStatus.PENDING,
        lastError: message,
        runAt: dead ? undefined : new Date(Date.now() + Math.min(60_000, 2 ** job.attempts * 1000)),
      },
    });
  }
}

export async function drainJobs(workerId: string, limit = 20): Promise<number> {
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const job = await claimNextJob(workerId);
    if (!job) break;
    await runJob(job);
    processed += 1;
  }
  return processed;
}
