import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatResourceEtag,
  parseResourceEtag,
  verifyResourceIfMatch,
} from "./resourceVersion";

void describe("resource-version HTTP preconditions", () => {
  void test("formats and parses a canonical opaque strong ETag", () => {
    const etag = formatResourceEtag({ kind: "invoice", id: "inv_123", version: 7 });

    assert.match(etag, /^"rv1_[A-Za-z0-9_-]+"$/u);
    assert.deepEqual(parseResourceEtag(etag), { kind: "invoice", id: "inv_123", version: 7 });
    assert.equal(parseResourceEtag(` ${etag} `)?.version, 7);
  });

  void test("rejects wildcards, weak/list tags, malformed payloads, and invalid version inputs", () => {
    for (const value of ["*", 'W/"rv1_abc"', '"rv1_abc", "rv1_def"', '"rv1_not-base64!"', '"rv1_e30"']) {
      assert.equal(parseResourceEtag(value), undefined, value);
    }
    assert.throws(() => formatResourceEtag({ kind: "invoice", id: "inv", version: -1 }));
    assert.throws(() => formatResourceEtag({ kind: "invoice", id: "", version: 0 }));
  });

  void test("requires an If-Match header before a conditional write", () => {
    assert.deepEqual(verifyResourceIfMatch(undefined, { kind: "customer", id: "cust_1" }, 2), {
      ok: false,
      status: 428,
      code: "PRECONDITION_REQUIRED",
      detail: "If-Match is required for this write",
    });
    assert.deepEqual(verifyResourceIfMatch("W/\"v1\"", { kind: "customer", id: "cust_1" }, 2), {
      ok: false,
      status: 400,
      code: "IF_MATCH_MALFORMED",
      detail: "If-Match must contain one supported strong resource ETag",
    });
  });

  void test("binds tags to their kind and id, and refuses stale or unavailable versions", () => {
    const invoiceTag = formatResourceEtag({ kind: "invoice", id: "inv_1", version: 3 });

    assert.deepEqual(verifyResourceIfMatch(invoiceTag, { kind: "order", id: "inv_1" }, 3), {
      ok: false,
      status: 412,
      code: "ETAG_RESOURCE_MISMATCH",
      detail: "If-Match belongs to a different resource",
    });
    assert.deepEqual(verifyResourceIfMatch(invoiceTag, { kind: "invoice", id: "inv_2" }, 3), {
      ok: false,
      status: 412,
      code: "ETAG_RESOURCE_MISMATCH",
      detail: "If-Match belongs to a different resource",
    });
    assert.deepEqual(verifyResourceIfMatch(invoiceTag, { kind: "invoice", id: "inv_1" }, 4), {
      ok: false,
      status: 412,
      code: "ETAG_VERSION_MISMATCH",
      detail: "If-Match does not match the current resource version",
    });
    assert.deepEqual(verifyResourceIfMatch(invoiceTag, { kind: "invoice", id: "inv_1" }, null), {
      ok: false,
      status: 412,
      code: "RESOURCE_VERSION_UNAVAILABLE",
      detail: "This resource is not yet versioned for conditional writes",
    });
  });

  void test("returns the matched version for a controller compare-and-swap predicate", () => {
    const tag = formatResourceEtag({ kind: "rate", id: "rate_1", version: 12 });
    assert.deepEqual(verifyResourceIfMatch(tag, { kind: "rate", id: "rate_1" }, 12), {
      ok: true,
      version: 12,
    });
  });
});
