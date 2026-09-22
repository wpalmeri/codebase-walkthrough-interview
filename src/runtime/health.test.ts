import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import { createApp } from "../app";
import {
  LivenessResponseSchema,
  NotReadyResponseSchema,
  ReadinessResponseSchema,
} from "./health";

async function request(
  app: ReturnType<typeof createApp>,
  path: string
): Promise<{ readonly status: number; readonly body: unknown }> {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

void describe("operational health endpoints", () => {
  void test("keeps liveness unauthenticated and independent of the database", async () => {
    let readinessCalls = 0;
    const response = await request(
      createApp({
        apiKey: "private-api-key",
        readinessProbe: async () => {
          readinessCalls += 1;
          throw new Error("database should not be queried by liveness");
        },
      }),
      "/health/live"
    );

    assert.equal(response.status, 200);
    assert.equal(LivenessResponseSchema.safeParse(response.body).success, true);
    assert.equal(readinessCalls, 0);
  });

  void test("reports readiness only after its dependency probe succeeds", async () => {
    let calls = 0;
    const response = await request(
      createApp({
        apiKey: "private-api-key",
        readinessProbe: async () => {
          calls += 1;
        },
      }),
      "/health/ready"
    );

    assert.equal(response.status, 200);
    assert.equal(ReadinessResponseSchema.safeParse(response.body).success, true);
    assert.equal(calls, 1);
  });

  void test("redacts dependency failures while making the process unavailable for traffic", async () => {
    const response = await request(
      createApp({
        readinessProbe: async () => {
          throw new Error("P1001 postgres://service-user:secret@private-db/meridian");
        },
      }),
      "/health/ready"
    );

    assert.equal(response.status, 503);
    assert.equal(NotReadyResponseSchema.safeParse(response.body).success, true);
    assert.doesNotMatch(JSON.stringify(response.body), /secret|private-db|postgres/i);
  });
});
