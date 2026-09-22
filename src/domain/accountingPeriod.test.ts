import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AccountingDateSchema,
  AccountingPeriodControlSchema,
  assertAccountingDateOpen,
  isAccountingDateClosed,
  parseAccountingDate,
  utcAccountingDateFromInstant,
} from "./accountingPeriod";

void describe("accounting calendar dates", () => {
  void test("uses UTC dates when translating legacy instants across month boundaries", () => {
    assert.equal(
      utcAccountingDateFromInstant(new Date("2026-03-01T00:30:00+01:00")),
      "2026-02-28"
    );
    assert.equal(
      utcAccountingDateFromInstant(new Date("2026-02-28T23:30:00-08:00")),
      "2026-03-01"
    );
  });

  void test("accepts calendar-valid leap days and rejects malformed or impossible dates", () => {
    assert.equal(AccountingDateSchema.safeParse("2028-02-29").success, true);
    assert.equal(AccountingDateSchema.safeParse("2027-02-29").success, false);
    assert.equal(AccountingDateSchema.safeParse("2026-2-01").success, false);
    assert.equal(AccountingDateSchema.safeParse("2026-13-01").success, false);
    assert.throws(() => parseAccountingDate("2026-02-30"));
  });

  void test("requires the explicit singleton control shape", () => {
    assert.equal(
      AccountingPeriodControlSchema.safeParse({ id: 1, closedThroughDate: "2026-01-31" }).success,
      true
    );
    assert.equal(
      AccountingPeriodControlSchema.safeParse({ id: 2, closedThroughDate: null }).success,
      false
    );
  });

  void test("treats the closed-through date as inclusive and permits the next open date", () => {
    const closedThrough = parseAccountingDate("2026-01-31");
    const finalDay = parseAccountingDate("2026-01-31");
    const nextDay = parseAccountingDate("2026-02-01");

    assert.equal(isAccountingDateClosed(finalDay, closedThrough), true);
    assert.equal(isAccountingDateClosed(nextDay, closedThrough), false);
    assert.throws(() => assertAccountingDateOpen(finalDay, closedThrough), /closed period/);
    assert.doesNotThrow(() => assertAccountingDateOpen(nextDay, closedThrough));
  });
});
