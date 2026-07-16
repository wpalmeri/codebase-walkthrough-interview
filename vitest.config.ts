import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    exclude: ["node_modules/**", "dist/**", "candidate-package/**"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
