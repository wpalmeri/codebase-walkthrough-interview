import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "ehr-api" },
});

export function moduleLogger(module: string) {
  return logger.child({ module });
}
