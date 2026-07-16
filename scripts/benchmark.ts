import { performance } from "node:perf_hooks";
import { buildApp } from "../src/app.js";

/**
 * Local performance demonstration. Runs a set of representative requests
 * against the seeded database and prints status, latency, and payload size.
 * These are the endpoints referenced in docs/performance/baseline.md; the
 * heavy ones exercise the legacy-hierarchy includes, per-row permission and
 * rate resolution, exact counts before pagination, and reporting on the
 * primary database.
 */
const app = await buildApp();

const scenarios: ReadonlyArray<readonly [string, string]> = [
  ["health", "/health"],
  ["order detail", "/orders/order_0"],
  ["patient directory", "/patients?userId=user_admin&pageSize=25"],
  ["patient header", "/patients/patient_000"],
  ["visit list", "/visits?userId=user_admin&pageSize=25"],
  ["visit detail", "/visits/visit_0_0_0/detail"],
  ["documentation backlog", "/documentation/backlog?userId=user_admin"],
  ["claim queue", "/claims?userId=user_admin&pageSize=25"],
  ["operations report", "/reports/operations?organizationId=org_northstar&start=2025-05-01&end=2025-08-01"],
  ["revenue report", "/reports/revenue?organizationId=org_northstar&start=2025-05-01&end=2025-08-01"],
  ["clinician productivity", "/reports/clinician-productivity?organizationId=org_northstar&start=2025-05-01&end=2025-08-01"],
  ["authorization report", "/reports/authorizations?organizationId=org_evergreen"],
  ["pricing export", "/exports/pricing?organizationId=org_evergreen"],
  ["enterprise export", "/exports/enterprise?organizationId=org_evergreen"],
  ["pricing compare", "/pricing/compare/visit_0_0_0"],
  ["ui dashboard", "/ui-api/dashboard?organizationId=org_northstar"],
  ["ui patients (enterprise)", "/ui-api/patients?organizationId=org_evergreen"],
];

console.log(`${"scenario".padEnd(26)} ${"code".padStart(4)} ${"latency".padStart(10)} ${"payload".padStart(10)}`);
console.log("-".repeat(56));

const rows: Array<{ name: string; ms: number }> = [];
for (const [name, url] of scenarios) {
  // Warm once, then measure, so first-call client init is not counted.
  await app.inject({ method: "GET", url });
  const started = performance.now();
  const response = await app.inject({ method: "GET", url });
  const elapsed = performance.now() - started;
  rows.push({ name, ms: elapsed });
  console.log(
    `${name.padEnd(26)} ${String(response.statusCode).padStart(4)} ${elapsed.toFixed(1).padStart(8)}ms ${(response.rawPayload.length / 1024).toFixed(1).padStart(8)} KiB`,
  );
}

const slowest = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 3);
console.log("-".repeat(56));
console.log(`slowest: ${slowest.map((row) => `${row.name} (${row.ms.toFixed(0)}ms)`).join(", ")}`);

await app.close();
