import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 doesn't catch async errors; wrap handlers so they reach the error middleware.
export function h(
  fn: (req: Request, res: Response) => Promise<unknown>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res)
      .then((result) => {
        if (!res.headersSent) res.json(result);
      })
      .catch(next);
  };
}

export function optionalQueryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
