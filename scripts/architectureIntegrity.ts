import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type ArchitectureDiagnostic = {
  readonly ruleId: "ARCH001" | "ARCH002" | "ARCH003" | "ARCH004" | "ARCH005";
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

const CENTRALIZED_LEGACY_CONVERSION_BOUNDARIES = new Set([
  "src/domain/money.ts",
  "client/src/api.ts",
]);

// These are compatibility read-model conversions retained for existing clients.
// Adding one requires an explicit review rather than silently widening this guard.
const LEGACY_FINANCIAL_CONVERSION_LINES = new Set([
  "src/domain/pricing.ts:77",
  "src/models/invoice.ts:52",
  "src/models/invoice.ts:53",
  "src/models/invoice.ts:57",
  "src/models/invoice.ts:76",
  "src/models/invoice.ts:77",
  "src/models/invoice.ts:78",
  "src/models/invoice.ts:87",
  "src/models/payment.ts:28",
  "src/models/payment.ts:55",
  "src/models/payment.ts:60",
  "src/models/payment.ts:61",
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

function diagnostic(
  ruleId: ArchitectureDiagnostic["ruleId"],
  file: string,
  line: number,
  message: string,
): ArchitectureDiagnostic {
  return { ruleId, path: file, line, message };
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
      checkFinancialConversions(root),
      checkPaymentApplicationMutations(root),
      checkZodModelTypes(root),
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
