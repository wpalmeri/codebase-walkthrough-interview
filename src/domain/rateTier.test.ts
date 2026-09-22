import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRateTiers, serializeRateTiers } from "./rateTier";

function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

void describe("rate tier schema", () => {
  void test("serializes exact tier JSON strings while reading legacy numeric storage", () => {
    assert.deepEqual(parseRateTiers(null), []);
    const legacy = [
      { upTo: 100, unitPrice: 4.5, floor: null },
      { upTo: null, unitPrice: 3.75, ceiling: 750 },
    ];
    const stored = serializeRateTiers(parseRateTiers(legacy));

    assert.deepEqual(stored, [
      { upTo: "100.000000", unitPrice: "4.5000", floor: null },
      { upTo: null, unitPrice: "3.7500", ceiling: "750.0000" },
    ]);
    assert.equal(typeof JSON.parse(JSON.stringify(stored))[0].unitPrice, "string");
    assert.deepEqual(parseRateTiers(stored), legacy);
    assert.deepEqual(parseRateTiers(legacy), legacy);
  });

  void test("rejects malformed tiers through the shared Zod model", () => {
    assert.throws(() => parseRateTiers({}), isZodError);
    assert.throws(() => parseRateTiers([{ upTo: 100, unitPrice: Number.NaN }]), isZodError);
    assert.throws(() => parseRateTiers([{ upTo: 0, unitPrice: 2 }]), isZodError);
    assert.throws(() => serializeRateTiers([{ upTo: 1, unitPrice: 1.00001 }]), /at most 4 decimal places/);
    assert.throws(
      () => serializeRateTiers([{ upTo: 1.0000001, unitPrice: 1 }]),
      /at most 6 decimal places/
    );
  });
});
