import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { createOpenApiV1Document } from "../src/openapi/document";
import { openApiV1Operations } from "../src/openapi/operations";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openApiPath = path.join(root, "openapi", "meridian-v1.openapi.json");
const clientTypesPath = path.join(root, "client", "src", "generated", "meridian-api.ts");

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

async function expectedArtifacts(): Promise<ReadonlyMap<string, string>> {
  const document = createOpenApiV1Document(openApiV1Operations);
  const json = `${JSON.stringify(sortJson(document), null, 2)}\n`;
  const ast = await openapiTS(Buffer.from(json), {
    alphabetize: true,
    immutable: true,
  });
  const types = `${COMMENT_HEADER}${astToString(ast)}`;
  return new Map([
    [openApiPath, json],
    [clientTypesPath, types],
  ]);
}

async function generate(): Promise<void> {
  const artifacts = await expectedArtifacts();
  for (const [file, contents] of artifacts) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }
  process.stdout.write("Generated the OpenAPI document and client types.\n");
}

async function check(): Promise<void> {
  const artifacts = await expectedArtifacts();
  const stale: string[] = [];
  for (const [file, expected] of artifacts) {
    let actual: string | undefined;
    try {
      actual = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        stale.push(path.relative(root, file));
        continue;
      }
      throw error;
    }
    if (actual !== expected) stale.push(path.relative(root, file));
  }

  if (stale.length > 0) {
    throw new Error(`OpenAPI artifacts are stale: ${stale.join(", ")}. Run \`bun run api:generate\`.`);
  }
  process.stdout.write("OpenAPI artifacts are current.\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    await check();
  } else {
    await generate();
  }
}

void main();
