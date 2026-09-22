import express from "express";
import type { NextFunction, Request, Response } from "express";
import { problemFromError, type ProblemDetails } from "./errors";
import {
  createAuthenticationMiddleware,
  createPrismaOperatorPrincipalResolver,
  ApiKeyPepperSchema,
  type OperatorPrincipalResolver,
} from "./auth/operatorPrincipal";
import { createIdempotencyMiddleware, createPrismaIdempotencyStore, type IdempotencyStore } from "./idempotency";
import { prisma } from "./db";
import {
  createPrismaReadinessProbe,
  liveness,
  readiness,
  type ReadinessProbe,
} from "./runtime/health";
import {
  createJsonPrivateErrorLogger,
  createPrivateErrorLog,
  createRequestContextMiddleware,
  type PrivateErrorLogSink,
} from "./runtime/requestContext";
import { api } from "./views";
import { assignApiVersion } from "./http/apiVersion";
import { JSON_BODY_LIMIT_BYTES } from "./http/jsonBody";

export { JSON_BODY_LIMIT_BYTES } from "./http/jsonBody";

export type AppOptions = {
  /**
   * Allows an embedding application to register additional routes before the
   * shared terminal error handlers. It also keeps HTTP-boundary tests fully
   * in-process without starting the production entrypoint.
   */
  configure?: (app: express.Express) => void;
  /** Receives raw failures for private logging; API responses always stay redacted. */
  logError?: (error: unknown, request: Request) => void;
  /**
   * Receives a JSON-safe structured event for unexpected server errors. This
   * excludes raw errors, request bodies, headers, cookies, and query strings.
   */
  privateErrorLogSink?: PrivateErrorLogSink;
  /** Overrides environment configuration for embedding and tests. */
  apiKey?: string | null;
  /** HMAC pepper for database-backed operator API keys. */
  apiKeyPepper?: string | null;
  /** Replaces database operator-key resolution in embedding and boundary tests. */
  principalResolver?: OperatorPrincipalResolver;
  environment?: string;
  /** Replaces durable idempotency persistence for isolated HTTP-boundary tests. */
  idempotencyStore?: IdempotencyStore;
  /** Replaces the production database readiness check for embedding and tests. */
  readinessProbe?: ReadinessProbe;
};

function sendProblem(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type("application/problem+json").json(problem);
}

function isMalformedJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;

  const parserError = error as SyntaxError & { status?: unknown; type?: unknown };
  return parserError.status === 400 || parserError.type === "entity.parse.failed";
}

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const parserError = error as { status?: unknown; type?: unknown };
  return parserError.status === 413 || parserError.type === "entity.too.large";
}

export function createApp(options: AppOptions = {}): express.Express {
  const configuredApiKey = options.apiKey ?? process.env.MERIDIAN_API_KEY?.trim() ?? "";
  const configuredApiKeyPepper = options.apiKeyPepper ?? process.env.MERIDIAN_API_KEY_PEPPER?.trim() ?? "";
  const environment = options.environment ?? process.env.NODE_ENV ?? "development";
  const principalResolver =
    options.principalResolver ??
    (configuredApiKeyPepper.length === 0 ? undefined : createPrismaOperatorPrincipalResolver(configuredApiKeyPepper));
  if (environment === "production" && configuredApiKey.length === 0 && principalResolver === undefined) {
    throw new Error("MERIDIAN_API_KEY or MERIDIAN_API_KEY_PEPPER is required in production");
  }
  const app = express();
  app.disable("x-powered-by");
  // Route handlers receive this already-validated secret through app-local
  // configuration rather than by consulting ambient environment at request time.
  if (configuredApiKeyPepper.length > 0) {
    app.locals.meridianApiKeyPepper = ApiKeyPepperSchema.parse(configuredApiKeyPepper);
  }
  const privateErrorLogSink =
    options.privateErrorLogSink ??
    (options.logError === undefined ? createJsonPrivateErrorLogger() : undefined);
  const logUnexpectedError = (
    error: unknown,
    request: Request,
    stage: "UNHANDLED" | "IDEMPOTENCY_PERSISTENCE",
    status = 500,
    code = "INTERNAL_ERROR"
  ): void => {
    options.logError?.(error, request);
    privateErrorLogSink?.(
      createPrivateErrorLog(request, {
        status,
        code,
        stage,
      })
    );
  };
  app.use(createRequestContextMiddleware());
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  const idempotency = createIdempotencyMiddleware(
    options.idempotencyStore ?? createPrismaIdempotencyStore(),
    (error, request) => logUnexpectedError(error, request, "IDEMPOTENCY_PERSISTENCE")
  );
  const readinessProbe = options.readinessProbe ?? createPrismaReadinessProbe(prisma);

  // These are intentionally public for orchestrators. They are registered
  // ahead of authentication and do not disclose database error details.
  app.get("/health/live", (_request, response) => {
    response.json(liveness());
  });
  app.get("/health/ready", async (_request, response) => {
    const result = await readiness(readinessProbe);
    response.status(result.status === "ready" ? 200 : 503).json(result);
  });

  const authenticate = createAuthenticationMiddleware({
    environment,
    legacyApiKey: configuredApiKey,
    principalResolver,
  });

  app.use("/api/v1", assignApiVersion("v1"), authenticate, idempotency, api);
  app.use(
    "/api",
    assignApiVersion("legacy"),
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

      if (isPayloadTooLarge(error)) {
        // body-parser exposes parser internals on this error, including byte
        // counts. Keep the public contract stable and do not treat a client
        // payload limit as an unexpected server failure.
        sendProblem(res, {
          type: "urn:meridian:problem:payload-too-large",
          title: "Request body too large",
          status: 413,
          code: "PAYLOAD_TOO_LARGE",
        });
        return;
      }

      const problem = problemFromError(error);
      if (problem.status >= 500) {
        logUnexpectedError(error, _req, "UNHANDLED", problem.status, problem.code);
      }
      sendProblem(res, problem);
    }
  );

  return app;
}
