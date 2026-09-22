import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRateTiers } from "./rateTier";

function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

void describe("rate tier schema", () => {
  void test("parses valid persisted tiers and normalizes null storage", () => {
    assert.deepEqual(parseRateTiers(null), []);
    assert.deepEqual(
      parseRateTiers([
        { upTo: 100, unitPrice: 4.5, floor: null },
        { upTo: null, unitPrice: 3.75, ceiling: 750 },
      ]),
      [
        { upTo: 100, unitPrice: 4.5, floor: null },
        { upTo: null, unitPrice: 3.75, ceiling: 750 },
      ]
    );
  });

  void test("rejects malformed tiers through the shared Zod model", () => {
    assert.throws(() => parseRateTiers({}), isZodError);
    assert.throws(() => parseRateTiers([{ upTo: 100, unitPrice: Number.NaN }]), isZodError);
    assert.throws(() => parseRateTiers([{ upTo: 0, unitPrice: 2 }]), isZodError);
  });
});
