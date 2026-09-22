import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "./app";
import type { Principal } from "./auth/principal";
import { prisma } from "./db";

void (async () => {
  let releaseSlowRequest: (() => void) | undefined;
  const slowRequestReleased = new Promise<void>((resolve) => {
    releaseSlowRequest = resolve;
  });
  let slowRequestStarted: (() => void) | undefined;
  const slowRequestHasStarted = new Promise<void>((resolve) => {
    slowRequestStarted = resolve;
  });
  let slowApplies = 0;
  const tenantA: Principal & { readonly tenantId: string } = {
    tenantId: "tenant-idempotency-a",
    subjectId: "tenant:tenant-idempotency-a",
    credentialId: "credential-idempotency-a",
    kind: "TENANT_API_KEY",
    role: "BILLING",
  };
  const tenantB: Principal & { readonly tenantId: string } = {
    tenantId: "tenant-idempotency-b",
    subjectId: "tenant:tenant-idempotency-b",
    credentialId: "credential-idempotency-b",
    kind: "TENANT_API_KEY",
    role: "BILLING",
  };
  await prisma.tenant.createMany({
    data: [
      { id: tenantA.tenantId, slug: "tenant-idempotency-a", name: "Tenant idempotency A" },
      { id: tenantB.tenantId, slug: "tenant-idempotency-b", name: "Tenant idempotency B" },
    ],
  });
  const app = createApp({
    principalResolver: {
      async resolve(token) {
        return token === "tenant-a-test-token" ? tenantA : token === "tenant-b-test-token" ? tenantB : null;
      },
    },
    configure(testApp) {
      let applies = 0;
      testApp.post("/api/durable-idempotency-scenario", (_request, response) => {
        applies += 1;
        response.status(201).type("application/vnd.meridian.receipt+json").send(`{"applies":${applies}}`);
      });
      testApp.post("/api/durable-idempotency-race", async (_request, response) => {
        slowApplies += 1;
        slowRequestStarted?.();
        await slowRequestReleased;
        response.status(202).json({ applied: slowApplies });
      });
    },
  });
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (token = "tenant-a-test-token") =>
      fetch(`${baseUrl}/api/durable-idempotency-scenario`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "durable-receipt-1",
          "idempotency-client": "database-integration-test",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: "12.3400" }),
      });

    const first = await request();
    const second = await request();
    const otherTenant = await request("tenant-b-test-token");
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(await first.text(), '{"applies":1}');
    assert.equal(await second.text(), '{"applies":1}');
    assert.equal(otherTenant.status, 201);
    assert.equal(await otherTenant.text(), '{"applies":2}');

    const records = await prisma.idempotencyRecord.findMany({ orderBy: { tenantId: "asc" } });
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.tenantId), [tenantA.tenantId, tenantB.tenantId]);
    for (const record of records) {
      assert.equal(record.state, "COMPLETED");
      assert.equal(record.responseStatus, 201);
      assert.equal(record.responseContentType, "application/vnd.meridian.receipt+json; charset=utf-8");
    }
    assert.equal(records[0]?.responseBodyBase64, Buffer.from('{"applies":1}').toString("base64"));
    assert.equal(records[1]?.responseBodyBase64, Buffer.from('{"applies":2}').toString("base64"));

    const slowRequest = () =>
      fetch(`${baseUrl}/api/durable-idempotency-race`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "durable-race-1",
          "idempotency-client": "database-integration-test",
          authorization: "Bearer tenant-a-test-token",
        },
        body: JSON.stringify({ amount: "5.0000" }),
      });
    const firstSlow = slowRequest();
    await slowRequestHasStarted;
    const concurrentSlow = await slowRequest();
    assert.equal(concurrentSlow.status, 409);
    assert.equal(slowApplies, 1);
    releaseSlowRequest?.();
    assert.equal((await firstSlow).status, 202);
    assert.equal((await slowRequest()).status, 202);
    assert.equal(slowApplies, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
    await prisma.$disconnect();
  }
})();
