import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { describe, test } from "node:test";
import express from "express";
import { assignApiVersion, isV1Request } from "./apiVersion";

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

void describe("server-derived API version", () => {
  void test("assigns the mount's explicit compatibility mode", async () => {
    const app = express();
    app.use("/v1", assignApiVersion("v1"));
    app.use("/legacy", assignApiVersion("legacy"));
    app.get("/:version", (request, response) => {
      response.json({ apiVersion: request.apiVersion, isV1: isV1Request(request) });
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("API-version test server has no TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      assert.deepEqual(await (await fetch(`${baseUrl}/v1`)).json(), { apiVersion: "v1", isV1: true });
      assert.deepEqual(await (await fetch(`${baseUrl}/legacy`)).json(), { apiVersion: "legacy", isV1: false });
    } finally {
      await close(server);
    }
  });
});
