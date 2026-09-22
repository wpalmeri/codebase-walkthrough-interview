import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Product } from "@meridian/contracts";
import { apiGet, decimalDisplay, isPositiveMoney, money, sumMoney } from "./api";

async function withFetch(response: Response, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => Promise.resolve(response),
  });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
}

void describe("exact client money helpers", () => {
  void test("formats canonical values without converting large amounts through Number", () => {
    assert.equal(money("900719925474099.0001"), "$900,719,925,474,099.00");
    assert.equal(money("1.0050"), "$1.01");
  });

  void test("sums binary-float-sensitive values exactly", () => {
    assert.equal(sumMoney(["0.1000", "0.2000"]), "0.3000");
    assert.equal(
      sumMoney(["900719925474099.0000", "0.0001"]),
      "900719925474099.0001"
    );
  });

  void test("compares exact zero without a numeric coercion", () => {
    assert.equal(isPositiveMoney("0.0000"), false);
    assert.equal(isPositiveMoney("0.0001"), true);
  });

  void test("trims display-only zeroes without changing the stored value", () => {
    assert.equal(decimalDisplay("3.000000"), "3");
    assert.equal(decimalDisplay("7.5000"), "7.5");
  });

  void test("validates legacy product responses while preserving exact decimal strings", async () => {
    await withFetch(
      new Response(
        JSON.stringify([
          {
            id: "product-1",
            sku: "WIDGET",
            name: "Widget",
            unit: "each",
            listPrice: 12.34,
            listPriceDecimal: "12.3400",
            currencyCode: "USD",
          },
        ])
      ),
      async () => {
        const products = await apiGet<Product[]>("/products");
        assert.equal(products[0]?.listPriceDecimal, "12.3400");
      }
    );
  });

  void test("rejects malformed successful responses without exposing their payload", async () => {
    await withFetch(
      new Response(JSON.stringify([{ id: "product-1", listPriceDecimal: "12.3400" }])),
      async () => {
        await assert.rejects(apiGet<Product[]>("/products"), {
          message: "Received an invalid response.",
        });
      }
    );
  });

  void test("uses only a validated Problem Details code for failed responses", async () => {
    await withFetch(
      new Response(
        JSON.stringify({
          type: "urn:meridian:problem:validation",
          title: "Validation failed",
          status: 422,
          code: "VALIDATION_ERROR",
          detail: "customer@example.com is not permitted",
        }),
        { status: 422 }
      ),
      async () => {
        await assert.rejects(apiGet<Product[]>("/products"), {
          message: "Request failed (422): VALIDATION_ERROR",
        });
      }
    );

    await withFetch(new Response("upstream diagnostic: customer@example.com", { status: 502 }), async () => {
      await assert.rejects(apiGet<Product[]>("/products"), {
        message: "Request failed (502)",
      });
    });
  });

  void test("rejects empty successful responses deterministically", async () => {
    await withFetch(new Response(null, { status: 204 }), async () => {
      await assert.rejects(apiGet<Product[]>("/products"), {
        message: "Received an empty response.",
      });
    });
  });
});
