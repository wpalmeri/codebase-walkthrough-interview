import express from "express";
import type { NextFunction, Request, Response } from "express";
import { api } from "./views";

type AppOptions = {
  /**
   * Allows an embedding application to register additional routes before the
   * shared terminal error handlers. It also keeps HTTP-boundary tests fully
   * in-process without starting the production entrypoint.
   */
  configure?: (app: express.Express) => void;
};

type Problem = {
  type: "about:blank";
  title: string;
  status: number;
  code: "INVALID_JSON" | "NOT_FOUND" | "INTERNAL_ERROR";
};

function sendProblem(res: Response, problem: Problem): void {
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
      type: "about:blank",
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
          type: "about:blank",
          title: "Malformed JSON request body",
          status: 400,
          code: "INVALID_JSON",
        });
        return;
      }

      console.error(error);
      sendProblem(res, {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        code: "INTERNAL_ERROR",
      });
    }
  );

  return app;
}
