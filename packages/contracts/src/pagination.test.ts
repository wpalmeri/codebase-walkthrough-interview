import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  DEFAULT_PAGE_LIMIT,
  PageEnvelopeSchema,
  PaginationQuerySchema,
  fingerprintPaginationFilters,
  formatPaginationCursor,
  parsePaginationCursor,
} from "./pagination.js";

void describe("cursor pagination contract", () => {
  const filterFingerprint = fingerprintPaginationFilters({
    customerId: "cust_1",
    status: "OPEN",
  });

  void test("round-trips a tied deterministic ordering tuple", () => {
    const cursor = formatPaginationCursor({
      resource: "orders",
      filterFingerprint,
      ordering: ["2026-09-22T12:00:00.000Z", "ord_0002"],
    });

    assert.match(cursor, /^pc1_[A-Za-z0-9_-]+$/u);
    assert.deepEqual(parsePaginationCursor(cursor, { resource: "orders", filterFingerprint }), {
      ok: true,
      ordering: ["2026-09-22T12:00:00.000Z", "ord_0002"],
    });
  });

  void test("uses the default bounded limit and rejects ambiguous or excessive limits", () => {
    assert.deepEqual(PaginationQuerySchema.parse({}), { limit: DEFAULT_PAGE_LIMIT });
    assert.deepEqual(PaginationQuerySchema.parse({ limit: "100" }), { limit: 100 });
    for (const limit of ["0", "101", "01", "1.0", 1.5]) {
      assert.equal(PaginationQuerySchema.safeParse({ limit }).success, false, String(limit));
    }
  });

  void test("rejects malformed, oversized, noncanonical, and future cursors with stable codes", () => {
    const binding = { resource: "orders", filterFingerprint };
    for (const cursor of ["not-a-cursor", `pc1_${"a".repeat(2_045)}`]) {
      assert.deepEqual(parsePaginationCursor(cursor, binding), { ok: false, code: "CURSOR_MALFORMED" });
    }
    const noncanonical = Buffer.from(
      JSON.stringify({ r: "orders", v: 1, f: filterFingerprint, o: ["ord_1"] }),
      "utf8"
    ).toString("base64url");
    assert.deepEqual(parsePaginationCursor(`pc1_${noncanonical}`, binding), {
      ok: false,
      code: "CURSOR_MALFORMED",
    });
    const future = Buffer.from(
      JSON.stringify({ v: 2, r: "orders", f: filterFingerprint, o: ["ord_1"] }),
      "utf8"
    ).toString("base64url");
    assert.deepEqual(parsePaginationCursor(`pc1_${future}`, binding), {
      ok: false,
      code: "CURSOR_UNSUPPORTED_VERSION",
    });
  });

  void test("binds cursors to both resource and normalized public filters", () => {
    const cursor = formatPaginationCursor({ resource: "orders", filterFingerprint, ordering: ["ord_1"] });
    assert.deepEqual(parsePaginationCursor(cursor, { resource: "invoices", filterFingerprint }), {
      ok: false,
      code: "CURSOR_RESOURCE_MISMATCH",
    });
    assert.deepEqual(
      parsePaginationCursor(cursor, {
        resource: "orders",
        filterFingerprint: fingerprintPaginationFilters({ status: "CLOSED", customerId: "cust_1" }),
      }),
      { ok: false, code: "CURSOR_FILTER_MISMATCH" }
    );
    assert.equal(
      fingerprintPaginationFilters({ status: "OPEN", customerId: "cust_1" }),
      fingerprintPaginationFilters({ customerId: "cust_1", status: "OPEN" })
    );
  });

  void test("enforces the exact additive page response envelope", () => {
    const schema = PageEnvelopeSchema(z.strictObject({ id: z.string(), value: z.number() }));
    const valid = {
      data: [{ id: "ord_1", value: 1 }],
      page: { limit: 50, nextCursor: "pc1_example" },
    };
    assert.deepEqual(schema.parse(valid), valid);
    assert.equal(schema.safeParse({ ...valid, total: 1 }).success, false);
    assert.equal(schema.safeParse({ ...valid, page: { ...valid.page, hasMore: true } }).success, false);
  });
});
