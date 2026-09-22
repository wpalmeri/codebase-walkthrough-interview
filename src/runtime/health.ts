import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

/** Public, unauthenticated response for process-level liveness checks. */
export const LivenessResponseSchema = z.strictObject({
  status: z.literal("ok"),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

/** Public response when every required local dependency is reachable. */
export const ReadinessResponseSchema = z.strictObject({
  status: z.literal("ready"),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

/** Public, deliberately redacted response when a required dependency is unavailable. */
export const NotReadyResponseSchema = z.strictObject({
  status: z.literal("not_ready"),
  code: z.literal("DATABASE_UNAVAILABLE"),
});
export type NotReadyResponse = z.infer<typeof NotReadyResponseSchema>;

export const ReadinessProbeResultSchema = z.discriminatedUnion("status", [
  ReadinessResponseSchema,
  NotReadyResponseSchema,
]);
export type ReadinessProbeResult = z.infer<typeof ReadinessProbeResultSchema>;

export type ReadinessProbe = () => Promise<void>;

/**
 * Uses a constant query through Prisma, so readiness represents an actually
 * usable database connection instead of merely a live Node process.
 */
export function createPrismaReadinessProbe(
  database: Pick<PrismaClient, "$queryRaw">
): ReadinessProbe {
  return async () => {
    await database.$queryRaw`SELECT 1`;
  };
}

export function liveness(): LivenessResponse {
  return LivenessResponseSchema.parse({ status: "ok" });
}

export async function readiness(probe: ReadinessProbe): Promise<ReadinessProbeResult> {
  try {
    await probe();
    return ReadinessResponseSchema.parse({ status: "ready" });
  } catch {
    // Dependency diagnostics belong in private logs/metrics, never in an
    // unauthenticated endpoint that can be polled from outside the service.
    return NotReadyResponseSchema.parse({
      status: "not_ready",
      code: "DATABASE_UNAVAILABLE",
    });
  }
}
