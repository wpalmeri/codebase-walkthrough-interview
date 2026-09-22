import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PrivateErrorLogSchema,
  RequestIdSchema,
  createJsonPrivateErrorLogger,
} from "./requestContext";

void describe("request correlation primitives", () => {
  void test("accepts only bounded opaque request IDs suitable for a response header", () => {
    assert.equal(RequestIdSchema.safeParse("gateway-8e0a_9f.1").success, true);
    assert.equal(RequestIdSchema.safeParse("contains a space").success, false);
    assert.equal(RequestIdSchema.safeParse("request\nlog-injection").success, false);
    assert.equal(RequestIdSchema.safeParse("a".repeat(129)).success, false);
  });

  void test("serializes only the approved structured error shape", () => {
    const output: string[] = [];
    const logger = createJsonPrivateErrorLogger((line) => output.push(line));
    logger({
      timestamp: "2026-09-22T00:00:00.000Z",
      level: "error",
      requestId: "server-correlation-id",
      method: "POST",
      path: "/api/payments/:id",
      status: 500,
      code: "INTERNAL_ERROR",
      stage: "UNHANDLED",
    });

    assert.equal(output.length, 1);
    const event = JSON.parse(output[0] ?? "") as unknown;
    assert.equal(PrivateErrorLogSchema.safeParse(event).success, true);
    assert.doesNotMatch(output[0] ?? "", /authorization|cookie|body|query/i);
  });
});
