import express from "express";
import type { NextFunction, Request, Response } from "express";
import { api } from "./views";

const app = express();
app.use(express.json());

app.use("/api", api);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4600);
app.listen(port, () => {
  console.log(`billing api listening on http://localhost:${port}`);
});
