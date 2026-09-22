import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { test } from "node:test";
import express from "express";
import { z } from "zod";
import { defineOperation, mountOperation } from "./operation";

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

void test("runtime success validation rejects invalid output without disclosing it", async () => {
  const requestSchema = z.strictObject({
    params: z.strictObject({}),
    query: z.strictObject({}),
    body: z.union([z.undefined(), z.strictObject({})]),
  });
  const operation = defineOperation({
    method: "get",
    path: "/output-contract-test",
    operationId: "outputContractTest",
    summary: "Test-only output contract",
    request: requestSchema,
    hasJsonBody: false,
    success: { status: 200, description: "Valid response", schema: z.strictObject({ id: z.string() }) },
    security: "tenantBearer",
    roles: ["ADMIN"] as const,
    errors: [500] as const,
    handler: async () => JSON.parse('{"id":42,"secret":"must-not-leak"}'),
  });
  const app = express();
  app.use((request, _response, next) => {
    request.principal = {
      tenantId: "output-contract-tenant",
      subjectId: "output-contract-subject",
      credentialId: "output-contract-credential",
      kind: "TENANT_API_KEY",
      role: "ADMIN",
    };
    next();
  });
  const router = express.Router();
  mountOperation(router, operation);
  app.use(router);
  app.use(
    (_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).type("application/problem+json").json({ code: "INTERNAL_ERROR" });
    }
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("output-contract test server has no TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/output-contract-test`);
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.match(text, /INTERNAL_ERROR/u);
    assert.doesNotMatch(text, /must-not-leak|Response contract violation/u);
  } finally {
    await close(server);
  }
});
