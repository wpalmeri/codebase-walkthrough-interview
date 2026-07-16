# INC-1101: Closed month changed after corrections

| Field | Value |
|---|---|
| Reported by | Priya Nadar, Controller (Finance) |
| Date reported | 2026-06-09 |
| Severity | SEV-2 (High) — financial reproducibility |
| Environment | Production; month close and revenue reporting |
| Component | Accounting / month close |
| Status | Open |

## Summary

Finance closed May and saved a revenue total. After the close, an operator
corrected a patient's coverage and a contract administrator updated a payer rate.
When the May revenue report was rerun, its total differed from the saved close
run.

## Steps to reproduce (as reported)

1. Close May for the organization and record the saved close total.
2. After the close, correct a patient's coverage for a visit that fell in May.
3. Separately, update a payer rate that applies to May service.
4. Rerun the May revenue report, or reopen May's close preview and compare its
   recognized revenue against the total saved at close.

## Observed

The reran May figure does not match the total saved at close. The difference
corresponds to the coverage and rate changes made after the close.

## Expected

A closed month should reproduce the total that was saved at close. A correction
made afterward should show up as an explicit adjustment, not change the historical
result.

## Impact

Finance cannot tell whether the original report was wrong, the correction should
be reflected in May, or the difference should be recorded in June. This blocks
sign-off and undermines trust in prior closes. See `docs/finance/month-close.md`
for the reproducibility requirement.

## Preliminary engineering note (tentative)

`calculatePeriod` (`src/accounting/month-close.ts`) re-derives the period's
numbers from live operational tables and current rates each time it runs. Closing
a period only flips its status — nothing is snapshotted at close, and nothing is
snapshotted at bill time either, so there is no stored figure to reproduce. The
accounting screen recomputes the closed period on every view, which is where this
was first noticed, but the same live-pricing path is used by the revenue report
and patient statements, so it is broader than the close. Whether a post-close
correction should backdate into the closed month or post to the open month is a
finance-policy decision we have not settled; engineering should not choose it
unilaterally.
