import { cents, money, multiplyMoney } from "../../src/lib/money.js";

describe("money", () => {
  it("rounds financial values half up", () => {
    expect(money("10.125").toString()).toBe("10.13");
    expect(money("10.124").toString()).toBe("10.12");
  });

  it("multiplies units before rounding", () => {
    expect(multiplyMoney("38.333", "1.25").toString()).toBe("47.92");
  });

  it("converts to integer cents", () => {
    expect(cents("149.50")).toBe(14950);
  });
});
