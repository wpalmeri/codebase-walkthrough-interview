import { env } from "./config/env.js";
import { moduleLogger } from "./lib/logger.js";
import { processPendingEvents } from "./workflows/workflow-runner.js";
import { drainJobs } from "./jobs/job-service.js";
import { registerJobHandlers } from "./jobs/handlers.js";

const log = moduleLogger("worker");
const workerId = `worker-${process.pid}`;

registerJobHandlers();

async function tick(): Promise<void> {
  try {
    const batches = await processPendingEvents();
    const jobs = await drainJobs(workerId);
    if (batches.length > 0 || jobs > 0) log.info({ eventBatches: batches.length, jobs }, "worker tick");
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, "worker tick failed");
  }
}

await tick();
setInterval(() => void tick(), env().workerPollIntervalMs);
log.info({ intervalMs: env().workerPollIntervalMs }, "worker started");
