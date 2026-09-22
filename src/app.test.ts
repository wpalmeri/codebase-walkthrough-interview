import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app";

type HttpResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

type ProblemResponse = {
  type: string;
  title: string;
  status: number;
  code: string;
};

function isProblemResponse(value: unknown): value is ProblemResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "status" in value &&
    typeof value.status === "number" &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function sendRequest(
  socketPath: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        socketPath,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      }
    );
    clientRequest.on("error", reject);
    clientRequest.end(options.body);
  });
}

async function withServer(
  run: (socketPath: string) => Promise<void>,
  configure?: Parameters<typeof createApp>[0]
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "meridian-app-"));
  const socketPath = join(temporaryDirectory, "server.sock");
  const server = createApp(configure).listen(socketPath);
  await once(server, "listening");

  try {
    await run(socketPath);
  } finally {
    server.close();
    await once(server, "close");
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function problem(response: HttpResponse) {
  assert.equal(response.headers["content-type"], "application/problem+json; charset=utf-8");
  const parsed: unknown = JSON.parse(response.body);
  assert.ok(isProblemResponse(parsed));
  return parsed;
}

void describe("HTTP application boundary", { concurrency: 1 }, () => {
  void test("returns a stable Problem Details response for unknown routes", async () => {
    await withServer(async (socketPath) => {
      const response = await sendRequest(socketPath, "/api/does-not-exist");

      assert.equal(response.status, 404);
      assert.deepEqual(problem(response), {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        code: "NOT_FOUND",
      });
    });
  });

  void test("rejects malformed JSON before an API controller can process it", async () => {
    await withServer(async (socketPath) => {
      const response = await sendRequest(socketPath, "/api/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"email":',
      });

      assert.equal(response.status, 400);
      assert.deepEqual(problem(response), {
        type: "about:blank",
        title: "Malformed JSON request body",
        status: 400,
        code: "INVALID_JSON",
      });
    });
  });

  void test("does not expose an unhandled error message", async () => {
    await withServer(
      async (socketPath) => {
        const response = await sendRequest(socketPath, "/__test/throws");

        assert.equal(response.status, 500);
        assert.deepEqual(problem(response), {
          type: "about:blank",
          title: "Internal Server Error",
          status: 500,
          code: "INTERNAL_ERROR",
        });
      },
      {
        configure: (app) => {
          app.get("/__test/throws", () => {
            throw new Error("database password should never reach the client");
          });
        },
      }
    );
  });
});
