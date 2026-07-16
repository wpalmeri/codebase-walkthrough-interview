# Current Month-Close Procedure

This document describes how finance closes a month today and what finance expects
from a close. It is written by the finance team for engineering, and describes
current behavior and requirements rather than a target design.

## What "closed" means today

Closing a month marks the accounting period so downstream reporting treats it as
final. It is only a status change:

- `closePeriod` (`src/accounting/month-close.ts`) sets the `AccountingPeriod` to
  `CLOSED` with `closedAt` and `closedBy`, writes an audit event, and emits an
  `accounting.period_closed` domain event. It does not compute or store any
  totals.
- The month's numbers — recognized revenue for the window, receivables as the sum
  of open claim balances, cash received in the window, and a count of
  completed-but-unbilled visits — are re-derived on demand by `calculatePeriod`
  from live operational tables and the currently active rates and coverage. There
  is no snapshot of what those numbers were at close.
- Nothing blocks operational writes dated inside a period that is already closed,
  and closing an already-closed period simply leaves the flag `CLOSED`.

## Reconciliation steps finance performs

1. Wait for the final nightly claim and payment jobs to run.
2. Export completed visits, expected reimbursement, claims, and cash for the
   month.
3. Compare claim balances against remittance applications, and confirm unapplied
   cash is understood.
4. Ask operations to resolve unsigned visits and missing coverage that would
   otherwise leave revenue unbilled.
5. Run the close and save the generated summary.
6. Confirm the period is marked closed.

Close currently takes two to four business days, most of it in steps 3 and 4.

## Reproducibility expectation

Finance's primary requirement is reproducibility:

> Once a month is closed, its reported financial position must remain
> reproducible. Later corrections must appear as explicit adjustments rather than
> silently changing the historical result.

In practice this means a report or re-derivation for a closed month should return
what was closed, and any subsequent change to that month should be visible as a
named adjustment with a reason and a link to what changed.

Finance has observed prior-month figures differing from what was reported at close
when a report is rerun after an upstream change — for example a coverage
correction or a payer-rate update entered after the close (see INC-1101). The
cause is that revenue is priced from the live rate and coverage tables at the
moment it is computed, and nothing is captured at bill time or close time. The
accounting screen re-derives the closed period's position every time it is opened,
so the number moves whenever an underlying rate or coverage changes. This is the
same live-pricing path that `reporting/revenue-report.ts` and patient statements
read through, so the discrepancy is not limited to the close screen — a rerun
revenue report or a regenerated statement can move for the same reason.

## How corrections are handled today

- `PeriodAdjustment` rows exist for recording explicit corrections against a
  period, with a description, amount, optional account, and creator. The close
  itself does not write adjustments; they are entered separately when a correction
  is identified.
- `FinancialPosting` rows exist for line-level financial facts (for example cash
  postings written during cash application) and are partially adopted; not every
  financial event writes one.
- There is currently nothing that snapshots the numbers a period reported at
  close, and nothing prevents operational writes dated inside a period that is
  already closed. A correction made after the close changes what the period
  re-derives rather than raising an adjustment.

Finance's stated expectation for corrections:

- Closed results must remain explainable and reproducible.
- A correction discovered later should be visible as an adjustment, not as a
  changed historical total.
- Each adjustment needs a link to the affected visit, claim, payment, or coverage
  correction.
- Reopening a period should be rare, permission controlled, and audited. The
  schema supports it (`PeriodStatus.REOPENED`, `reopenedAt`, `reopenedBy`).

## Scope

A full general-ledger product is not a prerequisite for the current roadmap.
Finance needs a close whose results are reproducible and whose corrections are
explicit and traceable; it does not need double-entry accounting, sub-ledgers, or
a chart of accounts beyond the accounts already used by the posting service. The
goal is that a closed month can be trusted and explained, and that later
corrections land somewhere visible.
