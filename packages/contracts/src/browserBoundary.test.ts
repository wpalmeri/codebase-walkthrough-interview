import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PaginationQuerySchema, ProductSchema } from "./index.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));

async function browserReachableModules(entry: string, visited = new Set<string>()): Promise<Set<string>> {
  if (visited.has(entry)) return visited;
  visited.add(entry);

  const source = await readFile(entry, "utf8");
  const imports = source.matchAll(/from\s+["'](\.[^"']+)["']/gu);
  await Promise.all(
    Array.from(imports, async ([, specifier]) => {
      const target = resolve(dirname(entry), specifier.replace(/\.js$/u, ".ts"));
      await browserReachableModules(target, visited);
    })
  );
  return visited;
}

void test("browser contract entry reaches only browser-safe modules", async () => {
  const manifest = z
    .object({
      exports: z.object({
        ".": z.object({ browser: z.string(), default: z.string() }),
      }),
    })
    .parse(JSON.parse(await readFile(resolve(packageDirectory, "../package.json"), "utf8")));
  assert.equal(manifest.exports["."].browser, "./src/index.ts");
  assert.equal(manifest.exports["."].default, "./src/server.ts");

  const modules = await browserReachableModules(resolve(packageDirectory, "index.ts"));
  for (const module of modules) {
    const source = await readFile(module, "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/u, module);
  }

  assert.equal(ProductSchema.safeParse({}).success, false);
  assert.deepEqual(PaginationQuerySchema.parse({}), { limit: 50 });
});
