import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type ArchitectureDiagnostic = {
  readonly ruleId:
    | "ARCH001"
    | "ARCH002"
    | "ARCH003"
    | "ARCH004"
    | "ARCH005"
    | "ARCH006"
    | "MIG001"
    | "MIG002"
    | "MIG003"
    | "MIG004"
    | "MIG005";
  readonly path: string;
  readonly line: number;
  readonly message: string;
};

const LEGACY_FLOAT_COLUMNS = new Set([
  "Product.listPrice",
  "Rate.unitPrice",
  "ComboDiscount.percentOff",
  "OrderItem.quantity",
  "OrderItem.unitPrice",
  "Invoice.total",
  "Invoice.amountPaid",
  "InvoiceLine.quantity",
  "InvoiceLine.unitPrice",
  "InvoiceLine.amount",
  "Payment.amount",
  "PaymentApplication.amount",
]);

const ENUM_BACKED_LIFECYCLE_FIELDS = new Map([
  ["Order.status", "OrderStatus"],
  ["Invoice.status", "InvoiceStatus"],
  ["Transmission.method", "TransmissionMethod"],
  ["Transmission.status", "TransmissionStatus"],
  ["IdempotencyRecord.method", "IdempotencyHttpMethod"],
  ["IdempotencyRecord.state", "IdempotencyRecordState"],
  ["AuditEvent.action", "AuditAction"],
  ["AuditEvent.principalKind", "AuditPrincipalKind"],
  ["AuditEvent.resourceKind", "AuditResourceKind"],
]);

const LIFECYCLE_LITERAL_VALUES = new Set([
  "OPEN",
  "INVOICED",
  "CLOSED",
  "DRAFT",
  "POSTED",
  "SENT",
  "PAID",
  "VOID",
  "QUEUED",
  "UPLOADING",
  "DELIVERED",
  "ACCEPTED",
  "FAILED",
  "EMAIL",
  "PORTAL",
  "API",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "IN_PROGRESS",
  "COMPLETED",
]);

// Literal enum definitions belong only in the contracts package and the
// idempotency schema, which is the source of truth for its Prisma enum. All
// application code must derive values from those schemas instead.
const LIFECYCLE_LITERAL_SCHEMA_DEFINITION_FILES = new Set([
  "packages/contracts/src/index.ts",
  "packages/contracts/src/requests.ts",
]);

const CENTRALIZED_LEGACY_CONVERSION_BOUNDARIES = new Set([
  "src/domain/money.ts",
  "client/src/api.ts",
]);

// These are compatibility read-model conversions retained for existing clients.
// Adding one requires an explicit review rather than silently widening this guard.
const LEGACY_FINANCIAL_CONVERSION_LINES = new Set([
  "src/domain/pricing.ts:77",
  "client/src/pages/ProductsPage.tsx:193",
]);

const APPROVED_PAYMENT_APPLICATION_MUTATION_PATHS = new Set([
  "src/controllers/paymentController.ts",
]);

const LEGACY_PAYMENT_APPLICATION_MUTATION_LINES = new Set([
  "src/jobs/legacyFinancialBackfill.ts:664",
]);

const FINANCIAL_SOURCE_ROOTS = ["src/domain", "src/controllers", "src/models"];
const BILLING_CLIENT_ROOTS = ["client/src/api.ts", "client/src/pages"];
const SHARED_MODEL_ROOTS = ["packages/contracts/src", "src", "client/src"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const MIGRATIONS_ROOT = "prisma/migrations";

type SqlToken = {
  readonly kind: "word" | "quoted" | "string" | "symbol";
  readonly value: string;
  readonly line: number;
};

type SqlTokenization = {
  readonly tokens: readonly SqlToken[];
  readonly error?: { readonly line: number; readonly message: string };
};

function hasNotFoundCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function filesUnder(root: string, relativePath: string): Promise<string[]> {
  const absolutePath = path.join(root, relativePath);
  try {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const child = path.posix.join(relativePath, entry.name);
        if (entry.isDirectory()) return filesUnder(root, child);
        return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [child] : [];
      }),
    );
    return files.flat();
  } catch (error: unknown) {
    if (hasNotFoundCode(error)) return [];
    throw error;
  }
}

async function sourceFiles(root: string, sourceRoots: readonly string[]): Promise<string[]> {
  const nested = await Promise.all(
    sourceRoots.map(async (sourceRoot) => {
      if (SOURCE_EXTENSIONS.has(path.extname(sourceRoot))) {
        try {
          await readFile(path.join(root, sourceRoot));
          return [sourceRoot];
        } catch (error: unknown) {
          if (hasNotFoundCode(error)) return [];
          throw error;
        }
      }
      return filesUnder(root, sourceRoot);
    }),
  );
  return [...new Set(nested.flat())]
    .filter((file) => !file.includes(".test.") && !file.includes(".scenario."))
    .toSorted();
}

async function migrationFiles(root: string): Promise<string[]> {
  try {
    const directories = await readdir(path.join(root, MIGRATIONS_ROOT), { withFileTypes: true });
    return directories
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.posix.join(MIGRATIONS_ROOT, entry.name, "migration.sql"))
      .toSorted();
  } catch (error: unknown) {
    if (hasNotFoundCode(error)) return [];
    throw error;
  }
}

function diagnostic(
  ruleId: ArchitectureDiagnostic["ruleId"],
  file: string,
  line: number,
  message: string,
): ArchitectureDiagnostic {
  return { ruleId, path: file, line, message };
}

function tokenizeSql(content: string): SqlTokenization {
  const tokens: SqlToken[] = [];
  let index = 0;
  let line = 1;

  const advance = (): string => {
    const character = content[index++];
    if (character === "\n") line += 1;
    return character;
  };
  const consumeQuoted = (quote: string, kind: SqlToken["kind"]): SqlTokenization["error"] | undefined => {
    const startLine = line;
    let value = "";
    advance();
    while (index < content.length) {
      const character = advance();
      if (character === quote) {
        if (content[index] === quote) {
          value += quote;
          advance();
          continue;
        }
        tokens.push({ kind, value, line: startLine });
        return undefined;
      }
      value += character;
    }
    return { line: startLine, message: `unterminated ${kind === "string" ? "string literal" : "quoted identifier"}` };
  };

  while (index < content.length) {
    const character = content[index];
    if (/\s/u.test(character)) {
      advance();
    } else if (character === "-" && content[index + 1] === "-") {
      while (index < content.length && advance() !== "\n") {
        // Ignore line comments so SQL-looking text cannot affect the guard.
      }
    } else if (character === "/" && content[index + 1] === "*") {
      const startLine = line;
      advance();
      advance();
      let closed = false;
      while (index < content.length) {
        if (content[index] === "*" && content[index + 1] === "/") {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) return { tokens, error: { line: startLine, message: "unterminated block comment" } };
    } else if (character === "'") {
      const error = consumeQuoted("'", "string");
      if (error) return { tokens, error };
    } else if (character === '"' || character === "`") {
      const error = consumeQuoted(character, "quoted");
      if (error) return { tokens, error };
    } else if (character === "[") {
      const startLine = line;
      let value = "";
      advance();
      while (index < content.length && content[index] !== "]") value += advance();
      if (index === content.length) return { tokens, error: { line: startLine, message: "unterminated quoted identifier" } };
      advance();
      tokens.push({ kind: "quoted", value, line: startLine });
    } else if (/[A-Za-z_]/u.test(character)) {
      const startLine = line;
      let value = "";
      while (index < content.length && /[A-Za-z0-9_$]/u.test(content[index])) value += advance();
      tokens.push({ kind: "word", value: value.toUpperCase(), line: startLine });
    } else {
      tokens.push({ kind: "symbol", value: advance(), line });
    }
  }
  return { tokens };
}

function words(tokens: readonly SqlToken[]): string[] {
  return tokens.filter((token) => token.kind === "word").map((token) => token.value);
}

function firstWord(tokens: readonly SqlToken[]): SqlToken | undefined {
  return tokens.find((token) => token.kind === "word");
}

function startsCreateTrigger(statementWords: readonly string[]): boolean {
  return (
    statementWords[0] === "CREATE" &&
    (statementWords[1] === "TRIGGER" ||
      ((statementWords[1] === "TEMP" || statementWords[1] === "TEMPORARY") && statementWords[2] === "TRIGGER"))
  );
}

function startsCreateIndex(statementWords: readonly string[]): boolean {
  return (
    statementWords[0] === "CREATE" &&
    (statementWords[1] === "INDEX" || (statementWords[1] === "UNIQUE" && statementWords[2] === "INDEX"))
  );
}

function allowedTopLevelStatement(tokens: readonly SqlToken[]): boolean {
  const statementWords = words(tokens);
  if (statementWords.length === 0) return true;
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statementWords[0])) return true;
  // Trigger replacement is required by existing SQLite migrations. Index
  // removal is not treated as harmless: it may remove uniqueness enforcement
  // or a production-critical access path.
  if (statementWords[0] === "DROP" && statementWords[1] === "TRIGGER") return true;
  if (startsCreateIndex(statementWords)) return true;
  if (statementWords[0] === "CREATE" && statementWords[1] === "TABLE") {
    return !statementWords.some((word, index) => word === "AS" && statementWords[index + 1] === "SELECT");
  }
  if (statementWords[0] !== "ALTER" || statementWords[1] !== "TABLE") return false;

  // Expand-only DDL is intentionally narrow. It accepts SQLite's ADD [COLUMN]
  // shape but does not try to prove arbitrary ALTER TABLE syntax harmless.
  const actionIndex = statementWords.findIndex((word, index) => index >= 2 && ["ADD", "DROP", "RENAME"].includes(word));
  return actionIndex >= 0 && statementWords[actionIndex] === "ADD";
}

function migrationStatementDiagnostic(file: string, tokens: readonly SqlToken[]): ArchitectureDiagnostic | undefined {
  const first = firstWord(tokens);
  if (!first) return undefined;
  const statementWords = words(tokens);
  const hasDropTableOrColumn =
    (statementWords[0] === "DROP" &&
      (statementWords[1] === "TABLE" || (statementWords[1] === "TEMPORARY" && statementWords[2] === "TABLE"))) ||
    (statementWords[0] === "ALTER" && statementWords[1] === "TABLE" && statementWords.includes("DROP")) ||
    (statementWords[0] === "DROP" && statementWords[1] === "INDEX");
  if (hasDropTableOrColumn) {
    return diagnostic(
      "MIG001",
      file,
      first.line,
      "destructive table, column, or index removal is forbidden in deploy migrations; use an explicitly reviewed contract-retirement process",
    );
  }
  if (
    (statementWords[0] === "ALTER" && statementWords[1] === "TABLE" && statementWords.includes("RENAME")) ||
    (statementWords[0] === "RENAME" && statementWords[1] === "TABLE")
  ) {
    return diagnostic(
      "MIG002",
      file,
      first.line,
      "table or column rename/rebuild patterns are forbidden in deploy migrations because they can rewrite live data",
    );
  }
  if (["INSERT", "UPDATE", "DELETE", "SELECT", "REPLACE"].includes(first.value)) {
    return diagnostic(
      "MIG003",
      file,
      first.line,
      "top-level DML or data scan is forbidden in deploy migrations; run backfills as bounded application jobs instead",
    );
  }
  if (statementWords[0] === "CREATE" && statementWords[1] === "TABLE" && statementWords.some((word, index) => word === "AS" && statementWords[index + 1] === "SELECT")) {
    return diagnostic(
      "MIG003",
      file,
      first.line,
      "CREATE TABLE AS SELECT performs a top-level data scan and is forbidden in deploy migrations",
    );
  }
  if (!allowedTopLevelStatement(tokens)) {
    return diagnostic(
      "MIG004",
      file,
      first.line,
      "unsupported or ambiguous top-level SQL; this conservative lexical guard permits only expand-only CREATE TABLE/INDEX, ALTER TABLE ADD, transaction control, and trigger bodies",
    );
  }
  return undefined;
}

async function checkMigrationSafety(root: string): Promise<ArchitectureDiagnostic[]> {
  // This is deliberately a conservative lexical ratchet, not a database
  // simulator. It does not prove lock duration, index-build cost, or trigger
  // semantics; deployment planning owns those concerns. It rejects unknown
  // top-level SQL rather than treating a partial parse as proof of safety, and
  // permits DML only inside SQLite's row-level CREATE TRIGGER ... BEGIN ... END.
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const file of await migrationFiles(root)) {
    const tokenization = tokenizeSql(await readFile(path.join(root, file), "utf8"));
    if (tokenization.error) {
      diagnostics.push(diagnostic("MIG005", file, tokenization.error.line, `unsafe SQL ambiguity: ${tokenization.error.message}`));
      continue;
    }

    let statement: SqlToken[] = [];
    let inTriggerBody = false;
    for (const token of tokenization.tokens) {
      if (token.value !== ";") {
        statement.push(token);
        continue;
      }
      const statementWords = words(statement);
      if (inTriggerBody) {
        // SQLite trigger bodies may legitimately contain row-scoped UPDATE,
        // DELETE, INSERT, and SELECT statements. Only a standalone END closes it.
        if (statementWords.length === 1 && statementWords[0] === "END") inTriggerBody = false;
      } else if (startsCreateTrigger(statementWords)) {
        if (!statementWords.includes("BEGIN")) {
          diagnostics.push(
            diagnostic(
              "MIG005",
              file,
              firstWord(statement)?.line ?? 1,
              "unsafe SQL ambiguity: CREATE TRIGGER must contain BEGIN before its first statement terminator",
            ),
          );
        } else {
          inTriggerBody = true;
        }
      } else {
        const issue = migrationStatementDiagnostic(file, statement);
        if (issue) diagnostics.push(issue);
      }
      statement = [];
    }
    if (inTriggerBody) {
      const line = statement[0]?.line ?? tokenization.tokens.at(-1)?.line ?? 1;
      diagnostics.push(diagnostic("MIG005", file, line, "unsafe SQL ambiguity: CREATE TRIGGER body is missing a standalone END;"));
    } else if (statement.length > 0) {
      const issue = migrationStatementDiagnostic(file, statement);
      if (issue) diagnostics.push(issue);
    }
  }
  return diagnostics;
}

async function checkFloatColumns(root: string): Promise<ArchitectureDiagnostic[]> {
  const relativePath = "prisma/schema.prisma";
  let content: string;
  try {
    content = await readFile(path.join(root, relativePath), "utf8");
  } catch (error: unknown) {
    if (hasNotFoundCode(error)) return [];
    throw error;
  }

  let model: string | undefined;
  return content.split("\n").flatMap((line, index) => {
    const modelMatch = /^\s*model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch) model = modelMatch[1];
    if (/^\s*}/.test(line)) model = undefined;
    const fieldMatch = /^\s*(\w+)\s+Float\b/.exec(line);
    if (!model || !fieldMatch || LEGACY_FLOAT_COLUMNS.has(`${model}.${fieldMatch[1]}`)) return [];
    return [
      diagnostic(
        "ARCH001",
        relativePath,
        index + 1,
        `Float column ${model}.${fieldMatch[1]} is not an approved legacy compatibility column`,
      ),
    ];
  });
}

async function checkLifecycleEnumColumns(root: string): Promise<ArchitectureDiagnostic[]> {
  const relativePath = "prisma/schema.prisma";
  let content: string;
  try {
    content = await readFile(path.join(root, relativePath), "utf8");
  } catch (error: unknown) {
    if (hasNotFoundCode(error)) return [];
    throw error;
  }

  let model: string | undefined;
  return content.split("\n").flatMap((line, index) => {
    const modelMatch = /^\s*model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch) model = modelMatch[1];
    if (/^\s*}/.test(line)) model = undefined;
    const fieldMatch = /^\s*(\w+)\s+(\w+)\b/.exec(line);
    if (!model || !fieldMatch) return [];
    const expectedType = ENUM_BACKED_LIFECYCLE_FIELDS.get(`${model}.${fieldMatch[1]}`);
    if (expectedType === undefined || fieldMatch[2] === expectedType) return [];
    return [
      diagnostic(
        "ARCH005",
        relativePath,
        index + 1,
        `lifecycle field ${model}.${fieldMatch[1]} must use Prisma enum ${expectedType}, not ${fieldMatch[2]}`,
      ),
    ];
  });
}

async function checkRawLifecycleLiterals(root: string): Promise<ArchitectureDiagnostic[]> {
  const files = await sourceFiles(root, ["src", "packages/contracts/src"]);
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const file of files) {
    if (LIFECYCLE_LITERAL_SCHEMA_DEFINITION_FILES.has(file)) continue;
    const lines = (await readFile(path.join(root, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      // The idempotency method schema has no shared API representation, so
      // its one-line Zod declaration is its explicitly approved boundary.
      if (file === "src/idempotency.ts" && /\bz\.enum\s*\(/u.test(line)) return;
      // Match only a complete, quoted literal. This deliberately does not
      // match explanatory text such as "Only a DRAFT invoice can...".
      const literals = line.matchAll(/(["'`])([A-Z_]+)\1/gu);
      for (const literal of literals) {
        const value = literal[2];
        if (!LIFECYCLE_LITERAL_VALUES.has(value)) continue;
        diagnostics.push(
          diagnostic(
            "ARCH006",
            file,
            index + 1,
            `raw lifecycle literal ${value} must be derived from its authoritative Zod schema`,
          ),
        );
      }
    });
  }
  return diagnostics;
}

function financialConversionOnLine(line: string): boolean {
  return (
    /\bparseFloat\s*\(/.test(line) ||
    /\bNumber\s*\(/.test(line) ||
    /(?:^|[=(:,[])\s*\+\s*(?:[A-Za-z_$][\w.$]*|\()/.test(line)
  );
}

async function checkFinancialConversions(root: string): Promise<ArchitectureDiagnostic[]> {
  const files = await sourceFiles(root, [...FINANCIAL_SOURCE_ROOTS, ...BILLING_CLIENT_ROOTS]);
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const file of files) {
    if (CENTRALIZED_LEGACY_CONVERSION_BOUNDARIES.has(file)) continue;
    const lines = (await readFile(path.join(root, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      const location = `${file}:${index + 1}`;
      if (financialConversionOnLine(line) && !LEGACY_FINANCIAL_CONVERSION_LINES.has(location)) {
        diagnostics.push(
          diagnostic(
            "ARCH002",
            file,
            index + 1,
            "financial conversion must use the decimal domain boundary instead of Number, parseFloat, or unary plus",
          ),
        );
      }
    });
  }
  return diagnostics;
}

async function checkPaymentApplicationMutations(root: string): Promise<ArchitectureDiagnostic[]> {
  const files = await sourceFiles(root, ["src"]);
  const mutation = /\.(paymentApplication|paymentApplicationReversal)\s*\.\s*(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/gu;
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const file of files) {
    if (APPROVED_PAYMENT_APPLICATION_MUTATION_PATHS.has(file)) continue;
    const content = await readFile(path.join(root, file), "utf8");
    for (const match of content.matchAll(mutation)) {
      const line = content.slice(0, match.index).split("\n").length;
      const location = `${file}:${line}`;
      if (!LEGACY_PAYMENT_APPLICATION_MUTATION_LINES.has(location)) {
        diagnostics.push(
          diagnostic(
            "ARCH003",
            file,
            line,
            "PaymentApplication mutations belong in the approved ledger controller or repository",
          ),
        );
      }
    }
  }
  return diagnostics;
}

async function checkZodModelTypes(root: string): Promise<ArchitectureDiagnostic[]> {
  const files = await sourceFiles(root, SHARED_MODEL_ROOTS);
  const handWrittenModel = /export\s+(?:interface\s+\w*(?:Response|Model|DTO|Dto|Contract)\b|type\s+\w*(?:Response|Model|DTO|Dto|Contract)\s*=\s*\{)/gu;
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8");
    for (const match of content.matchAll(handWrittenModel)) {
      const line = content.slice(0, match.index).split("\n").length;
      diagnostics.push(
        diagnostic(
          "ARCH004",
          file,
          line,
          "exported API/shared model types must be inferred from a Zod schema",
        ),
      );
    }
  }
  return diagnostics;
}

export async function runArchitectureIntegrity(root = process.cwd()): Promise<ArchitectureDiagnostic[]> {
  const diagnostics = (
    await Promise.all([
      checkFloatColumns(root),
      checkLifecycleEnumColumns(root),
      checkRawLifecycleLiterals(root),
      checkFinancialConversions(root),
      checkPaymentApplicationMutations(root),
      checkZodModelTypes(root),
      checkMigrationSafety(root),
    ])
  ).flat();
  return diagnostics.toSorted((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  );
}

async function main(): Promise<void> {
  const diagnostics = await runArchitectureIntegrity();
  if (diagnostics.length === 0) return;
  for (const item of diagnostics) {
    console.error(`${item.ruleId} ${item.path}:${item.line} ${item.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
