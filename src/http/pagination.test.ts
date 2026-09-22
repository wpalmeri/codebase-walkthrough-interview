import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { pageEnvelope, formatNextPageLink } from "./pagination";

void describe("pagination HTTP helpers", () => {
  void test("formats a safe RFC next relation with an encoded opaque cursor", () => {
    assert.equal(
      formatNextPageLink("/api/v1/orders?status=OPEN", "pc1_a-b_c"),
      '</api/v1/orders?status=OPEN&cursor=pc1_a-b_c>; rel="next"'
    );
    assert.equal(formatNextPageLink("/api/v1/orders", null), undefined);
    assert.throws(() => formatNextPageLink("https://attacker.example/orders", "pc1_cursor"));
    assert.throws(() => formatNextPageLink("/api/orders\r\nX-Injected: yes", "pc1_cursor"));
  });

  void test("parses response data through the exact page envelope", () => {
    assert.deepEqual(
      pageEnvelope(z.strictObject({ id: z.string() }), [{ id: "cust_1" }], {
        limit: 50,
        nextCursor: null,
      }),
      { data: [{ id: "cust_1" }], page: { limit: 50, nextCursor: null } }
    );
  });
});
