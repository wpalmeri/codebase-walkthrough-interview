# INC-1120: Completed visit reports disagree

| Field | Value |
|---|---|
| Reported by | Alicia Romero, Operations Analytics |
| Date reported | 2026-05-27 |
| Severity | SEV-3 (Medium) — reporting trust |
| Environment | Production; operations dashboard and revenue report |
| Component | Reporting |
| Status | Open |

## Summary

For the same organization and date range, the operations dashboard reported 1,842
completed visits while the revenue report reported 1,906 completed visits. Both
numbers claim to count "completed visits."

## Steps to reproduce (as reported)

1. Run the operations dashboard for a customer and date range; read the
   "completed visits" figure.
2. Run the revenue report for the same customer and date range; read its visit
   count.
3. Compare the two totals.

## Observed

The two figures differ by 64 for the sampled range. The gap is larger for ranges
that include older records.

## Expected

Two reports labeled "completed visits" for the same scope should agree, or should
clearly state that they count different things.

## Impact

The dashboard owner reads one row as one visit. Billing reads only independently
delivered service records as countable. Analysts cannot reconcile operational and
revenue views, which slows monthly reporting and erodes confidence in both
numbers.

## Preliminary engineering note (tentative)

The two reports appear to count at different grains. The operations dashboard
(`src/reporting/operations-report.ts`) counts completed visit *groups* and labels
them "completed visits," while the revenue report
(`src/reporting/revenue-report.ts`) counts completed *visits* whose `completedAt`
falls in the window. Several historical records contain more than one visit inside
a single group, which would make the group count run lower. Which definition is
canonical is a product decision; see the count definitions in
`docs/data-dictionary.md`.
