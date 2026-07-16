export interface AppEnv {
  port: number;
  logLevel: string;
  databaseUrl: string;
  modelProvider: string;
  clearinghouseUrl: string;
  crmUrl: string;
  workerPollIntervalMs: number;
}

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  cached = {
    port: Number(process.env.PORT ?? 3000),
    logLevel: process.env.LOG_LEVEL ?? "info",
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://ehr:ehr@localhost:54329/ehr?schema=public",
    modelProvider: process.env.MODEL_PROVIDER ?? "fake",
    clearinghouseUrl: process.env.CLEARINGHOUSE_URL ?? "http://localhost:3000/simulators/clearinghouse",
    crmUrl: process.env.CRM_URL ?? "http://localhost:3000/simulators/crm",
    workerPollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000),
  };
  return cached;
}
