import { defineConfig } from "prisma/config";

/**
 * Keep Prisma's schema, migration history, and seed command in the supported
 * typed configuration boundary. DATABASE_URL remains an ordinary environment
 * variable owned by the datasource in schema.prisma; no secret is embedded
 * here or substituted with an unsafe default.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
