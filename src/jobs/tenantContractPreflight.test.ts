import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Prisma } from "@prisma/client";
import {
  MAX_TENANT_CONTRACT_PREFLIGHT_COUNT,
  TenantContractPreflightOptionsSchema,
  runTenantContractPreflight,
  type TenantContractPreflightQueryClient,
} from "./tenantContractPreflight";

function sqlText(query: Prisma.Sql): string {
  const value = Reflect.get(query, "sql");
  return typeof value === "string" ? value : "";
}

function boundedFixtureClient(): TenantContractPreflightQueryClient {
  return {
    async $queryRaw(query: Prisma.Sql): Promise<unknown> {
      const sql = sqlText(query);
      if (sql.includes("integrity_check")) return [{ integrity_check: "ok" }];
      if (sql.includes("COUNT(*)")) return [{ count: BigInt(MAX_TENANT_CONTRACT_PREFLIGHT_COUNT + 1) }];
      return Array.from({ length: 100 }, () => ({
        sample: "x".repeat(2_000),
        tableName: "OrderComment",
        rowId: "1",
        parentName: "Order",
        foreignKeyId: "0",
      }));
    },
  };
}

void describe("tenant contract preflight", () => {
  void test("bounds aggregate counts and samples even when a query client returns excessive evidence", async () => {
    const result = await runTenantContractPreflight(
      { maxIssueSamples: 1 },
      { client: boundedFixtureClient() }
    );

    assert.equal(result.state, "BLOCKED");
    assert.equal(result.ready, false);
    assert.equal(result.issues.length, 16);
    for (const issue of result.issues) {
      assert.equal(issue.count, MAX_TENANT_CONTRACT_PREFLIGHT_COUNT);
      assert.equal(issue.countTruncated, true);
      assert.ok(issue.samples.length <= 1);
      for (const sample of issue.samples) assert.ok(sample.length <= 512);
    }
  });

  void test("rejects output settings that could make a corrupt database produce an unbounded report", () => {
    assert.throws(() => TenantContractPreflightOptionsSchema.parse({ maxIssueSamples: 26 }));
    assert.throws(() => TenantContractPreflightOptionsSchema.parse({ maxIssueSamples: 0 }));
  });
});
