import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __ehrPrisma: PrismaClient | undefined;
}

export const db = globalThis.__ehrPrisma ?? new PrismaClient({
  log: process.env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
});

if (process.env.NODE_ENV !== "production") globalThis.__ehrPrisma = db;
