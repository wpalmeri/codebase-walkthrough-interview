import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AuthenticationError, problemFromError, type ProblemDetails } from "./errors";
import { createIdempotencyMiddleware, createPrismaIdempotencyStore, type IdempotencyStore } from "./idempotency";
import { api } from "./views";

type AppOptions = {
  /**
   * Allows an embedding application to register additional routes before the
   * shared terminal error handlers. It also keeps HTTP-boundary tests fully
   * in-process without starting the production entrypoint.
   */
  configure?: (app: express.Express) => void;
  /** Receives raw failures for private logging; API responses always stay redacted. */
  logError?: (error: unknown, request: Request) => void;
  /** Overrides environment configuration for embedding and tests. */
  apiKey?: string | null;
  environment?: string;
  /** Replaces durable idempotency persistence for isolated HTTP-boundary tests. */
  idempotencyStore?: IdempotencyStore;
};

function sendProblem(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type("application/problem+json").json(problem);
}

function isMalformedJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;

  const parserError = error as SyntaxError & { status?: unknown; type?: unknown };
  return parserError.status === 400 || parserError.type === "entity.parse.failed";
}

function bearerToken(request: Request): string | null {
  const authorization = request.get("authorization");
  if (authorization === undefined) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1] ?? null;
}

function tokensMatch(supplied: string | null, expected: string): boolean {
  if (supplied === null) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

export function createApp(options: AppOptions = {}): express.Express {
  const configuredApiKey = options.apiKey ?? process.env.MERIDIAN_API_KEY?.trim() ?? "";
  const environment = options.environment ?? process.env.NODE_ENV ?? "development";
  if (environment === "production" && configuredApiKey.length === 0) {
    throw new Error("MERIDIAN_API_KEY is required in production");
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  const idempotency = createIdempotencyMiddleware(options.idempotencyStore ?? createPrismaIdempotencyStore());

  const authenticate = (request: Request, response: Response, next: NextFunction) => {
    if (configuredApiKey.length === 0 || tokensMatch(bearerToken(request), configuredApiKey)) {
      next();
      return;
    }
    response.set("WWW-Authenticate", 'Bearer realm="meridian-api"');
    sendProblem(response, new AuthenticationError().problem);
  };

  app.use("/api/v1", authenticate, idempotency, api);
  app.use(
    "/api",
    (_req: Request, res: Response, next: NextFunction) => {
      res.append("Link", '</api/v1>; rel="successor-version"');
      next();
    },
    authenticate,
    idempotency,
    api
  );
  options.configure?.(app);

  app.use((_req: Request, res: Response) => {
    sendProblem(res, {
      type: "urn:meridian:problem:not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  app.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      if (res.headersSent) return;

      if (isMalformedJson(error)) {
        sendProblem(res, {
          type: "urn:meridian:problem:invalid-json",
          title: "Malformed JSON request body",
          status: 400,
          code: "INVALID_JSON",
        });
        return;
      }

      const problem = problemFromError(error);
      if (problem.status >= 500) {
        (options.logError ?? console.error)(error, _req);
      }
      sendProblem(res, problem);
    }
  );

  return app;
}
