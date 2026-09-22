import { createApp } from "./app";
import { prisma } from "./db";
import { createRuntimeLifecycle, installShutdownHandlers } from "./runtime/lifecycle";

const port = Number(process.env.PORT ?? 4600);
const app = createApp();
const server = app.listen(port, () => {
  console.log(`billing api listening on http://localhost:${port}`);
});

installShutdownHandlers(createRuntimeLifecycle({ server, database: prisma }));
