import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRuntimeLifecycle, installShutdownHandlers } from "./lifecycle";

function unresolved<T>(_value: T | PromiseLike<T>): void {}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = unresolved;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeServer(events: string[]) {
  let onClose: ((error?: Error) => void) | undefined;
  const server = {
    close(callback: (error?: Error) => void) {
      events.push("server.close");
      onClose = callback;
      return server;
    },
    closeAllConnections() {
      events.push("server.closeAllConnections");
    },
    finishClose() {
      onClose?.();
    },
  };
  return server;
}

const quietLogger = { info: () => undefined, error: () => undefined };

void describe("runtime lifecycle", () => {
  void test("stops accepting requests and disconnects Prisma only after a normal drain", async () => {
    const events: string[] = [];
    const server = fakeServer(events);
    const lifecycle = createRuntimeLifecycle({
      server,
      database: {
        async $disconnect() {
          events.push("database.disconnect");
        },
      },
      logger: quietLogger,
    });

    const shutdown = lifecycle.shutdown("SIGTERM");
    assert.deepEqual(events, ["server.close"]);

    server.finishClose();
    assert.deepEqual(await shutdown, { signal: "SIGTERM", outcome: "DRAINED" });
    assert.deepEqual(events, ["server.close", "database.disconnect"]);
  });

  void test("forces remaining sockets at the deadline before releasing the database client", async () => {
    const events: string[] = [];
    const deadline = deferred<void>();
    const server = fakeServer(events);
    const lifecycle = createRuntimeLifecycle({
      server,
      database: {
        async $disconnect() {
          events.push("database.disconnect");
        },
      },
      logger: quietLogger,
      createDeadline: () => ({
        expired: deadline.promise,
        cancel() {
          events.push("deadline.cancel");
        },
      }),
    });

    const shutdown = lifecycle.shutdown("SIGINT");
    assert.deepEqual(events, ["server.close"]);

    deadline.resolve();
    assert.deepEqual(await shutdown, { signal: "SIGINT", outcome: "FORCED" });
    assert.deepEqual(events, [
      "server.close",
      "deadline.cancel",
      "server.closeAllConnections",
      "database.disconnect",
    ]);
  });

  void test("coalesces repeated shutdown requests into one drain and one disconnect", async () => {
    const events: string[] = [];
    const server = fakeServer(events);
    const lifecycle = createRuntimeLifecycle({
      server,
      database: {
        async $disconnect() {
          events.push("database.disconnect");
        },
      },
      logger: quietLogger,
    });

    const first = lifecycle.shutdown("SIGTERM");
    const second = lifecycle.shutdown("SIGINT");
    assert.strictEqual(second, first);
    assert.deepEqual(events, ["server.close"]);

    server.finishClose();
    assert.deepEqual(await first, { signal: "SIGTERM", outcome: "DRAINED" });
    assert.deepEqual(events, ["server.close", "database.disconnect"]);
  });

  void test("binds both termination signals but exits once for the first signal", async () => {
    const events: string[] = [];
    const server = fakeServer(events);
    const lifecycle = createRuntimeLifecycle({
      server,
      database: {
        async $disconnect() {
          events.push("database.disconnect");
        },
      },
      logger: quietLogger,
    });
    const handlers = new Map<string, () => void>();
    const exited = deferred<void>();
    const exitCodes: number[] = [];
    installShutdownHandlers(lifecycle, {
      once(signal, listener) {
        handlers.set(signal, listener);
      },
      exit(code = 0) {
        exitCodes.push(code);
        exited.resolve();
      },
    });

    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    assert.deepEqual(events, ["server.close"]);

    server.finishClose();
    await exited.promise;
    assert.deepEqual(events, ["server.close", "database.disconnect"]);
    assert.deepEqual(exitCodes, [0]);
  });
});
