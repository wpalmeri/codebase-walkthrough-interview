import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export const ShutdownSignalSchema = z.enum(["SIGINT", "SIGTERM"]);
export type ShutdownSignal = z.infer<typeof ShutdownSignalSchema>;

export const ShutdownResultSchema = z.strictObject({
  signal: ShutdownSignalSchema,
  outcome: z.enum(["DRAINED", "FORCED"]),
});
export type ShutdownResult = z.infer<typeof ShutdownResultSchema>;

type ShutdownServer = {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
};
type ShutdownDatabase = Pick<PrismaClient, "$disconnect">;
type ShutdownLogger = Pick<Console, "error" | "info">;

type ShutdownDeadline = {
  readonly expired: Promise<void>;
  cancel(): void;
};

type ShutdownOptions = {
  readonly server: ShutdownServer;
  readonly database: ShutdownDatabase;
  readonly drainTimeoutMs?: number;
  readonly logger?: ShutdownLogger;
  /** Injectable only to make lifecycle behavior deterministic under test. */
  readonly createDeadline?: (timeoutMs: number) => ShutdownDeadline;
};

type ShutdownSignalProcess = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code?: number): void;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

function createDeadline(timeoutMs: number): ShutdownDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    expired: new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function closeServer(server: ShutdownServer, logger: ShutdownLogger): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close((error) => {
        if (error !== undefined) logger.error("HTTP server close failed", error);
        resolve();
      });
    } catch (error: unknown) {
      logger.error("HTTP server close failed", error);
      resolve();
    }
  });
}

/**
 * Coordinates shutdown as a single shared operation. Server.close immediately
 * stops new connections; in-flight requests may complete until the deadline,
 * at which point remaining sockets are force-closed before Prisma disconnects.
 */
export function createRuntimeLifecycle(options: ShutdownOptions) {
  const logger = options.logger ?? console;
  const timeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const deadlineFactory = options.createDeadline ?? createDeadline;
  let activeShutdown: Promise<ShutdownResult> | undefined;

  const shutdown = (requestedSignal: ShutdownSignal): Promise<ShutdownResult> => {
    const signal = ShutdownSignalSchema.parse(requestedSignal);
    if (activeShutdown !== undefined) return activeShutdown;

    activeShutdown = (async () => {
      logger.info(`received ${signal}; draining HTTP requests`);
      const deadline = deadlineFactory(timeoutMs);
      const close = closeServer(options.server, logger);
      const outcome = await Promise.race([
        close.then(() => "DRAINED" as const),
        deadline.expired.then(() => "FORCED" as const),
      ]);
      deadline.cancel();

      if (outcome === "FORCED") {
        logger.error(`HTTP drain exceeded ${timeoutMs}ms; closing remaining connections`);
        options.server.closeAllConnections?.();
        // The close callback can now wait on an implementation-specific socket
        // cleanup path. It must not postpone release of the database client.
        void close;
      }

      await options.database.$disconnect();
      return ShutdownResultSchema.parse({ signal, outcome });
    })();

    return activeShutdown;
  };

  return { shutdown };
}

/** Installs one-shot production signal handlers around an injectable lifecycle. */
export function installShutdownHandlers(
  lifecycle: ReturnType<typeof createRuntimeLifecycle>,
  processRef: ShutdownSignalProcess = process
): void {
  let stopping = false;
  const handle = (signal: ShutdownSignal) => {
    if (stopping) return;
    stopping = true;
    void lifecycle.shutdown(signal).then(
      () => processRef.exit(0),
      (error: unknown) => {
        console.error("graceful shutdown failed", error);
        processRef.exit(1);
      }
    );
  };

  processRef.once("SIGTERM", () => handle("SIGTERM"));
  processRef.once("SIGINT", () => handle("SIGINT"));
}
