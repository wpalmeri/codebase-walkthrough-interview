import express from "express";
import type { NextFunction, Request, Response } from "express";
import { problemFromError, type ProblemDetails } from "./errors";
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
};

function sendProblem(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type("application/problem+json").json(problem);
}

function isMalformedJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;

  const parserError = error as SyntaxError & { status?: unknown; type?: unknown };
  return parserError.status === 400 || parserError.type === "entity.parse.failed";
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.use("/api", api);
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
