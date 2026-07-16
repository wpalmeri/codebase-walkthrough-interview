import { EventEmitter } from "node:events";
import { moduleLogger } from "../lib/logger.js";

/**
 * In-process pub/sub. Handlers run synchronously in the emitting request and
 * are not retried; a slow subscriber slows the request that emitted.
 */

const log = moduleLogger("event-bus");
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export type InProcessHandler = (payload: Record<string, unknown>) => void | Promise<void>;

export function subscribe(eventName: string, handler: InProcessHandler): void {
  emitter.on(eventName, (payload: Record<string, unknown>) => {
    void Promise.resolve(handler(payload)).catch((error) => {
      log.warn({ eventName, error: error instanceof Error ? error.message : String(error) }, "in-process handler failed");
    });
  });
}

export async function emitInProcess(eventName: string, payload: Record<string, unknown>): Promise<void> {
  const listeners = emitter.listeners(eventName);
  for (const listener of listeners) {
    await (listener as InProcessHandler)(payload);
  }
}

export function emitInProcessSync(eventName: string, payload: Record<string, unknown>): void {
  emitter.emit(eventName, payload);
}
