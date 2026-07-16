# Data Dictionary

The definitions below reflect current operational usage. Several teams use more
specific definitions in individual screens and reports; where two definitions of
the same metric exist, both are recorded here so a reader can tell which one a
given number came from.

## Core entities

| Term | Current meaning |
|---|---|
| Organization | One customer tenant. The `enterprise` flag marks larger accounts |
| Region / Branch / Team | Optional org sub-structure. Branch is the unit most permission and reporting paths key on |
| Patient | A person receiving services within one customer organization |
| Active patient | A patient whose `active` flag is true; some reports instead require a visit in the selected period |
| Care episode | A period of related care for a patient |
| Service order | A clinician's order for a type of service, under a care episode |
| Visit set | Visits created from one order, normally sharing authorization and coverage |
| Visit group | A scheduled delivery group, historically visits delivered together or in one weekly block |
| Visit | A scheduled unit of service delivered by a clinician, inside a visit group |
| Coverage | An `InsuranceCoverage` row for a patient; a patient may have several, with a `priority` and a `currentCoverageId` pointer |
| Authorization | A payer approval for up to `maxVisits` of a service type within an effective window |
| Payer contract / rate | A `PayerContract` (with `precedence` and `version`) holds `PayerRate` rows; `StandardRate` is the fallback |

## Visit-status and documentation terms

| Term | Current meaning |
|---|---|
| Completed visit | Usually a visit with status `COMPLETED`; some operations views instead count completed visit *groups* |
| Signed visit | A completed visit whose clinical note has status `SIGNED` |
| Billable visit | A completed visit satisfying documentation, authorization, coverage, and service-code requirements |
| Documentation status (live) | Derived from `ClinicalNote` rows for a visit at read time |
| Documentation status (cached) | `VisitGroup.documentationStatus`, written by `recomputeGroupDocumentationStatus` on completion and read by billing readiness, reports, and workflows. It is not recomputed when a note is edited after signing or when a visit changes groups |

## Count definitions

At least ten exact-count paths exist, with names that do not reveal their
differing definitions. All are scoped to a visit set unless noted.

| Name | Where defined | Counts |
|---|---|---|
| `visitCount` | `visits/visit-counts.ts`, `orders/order-summary.ts` | All non-deleted visits, including `CANCELLED` and `NO_SHOW` |
| `completedCount` | `visits/visit-counts.ts`, `orders/order-summary.ts` | Visits with status `COMPLETED` |
| `usedVisits` | `visits/visit-counts.ts`, `visits/visit-service.ts` | `SCHEDULED` + `IN_PROGRESS` + `COMPLETED` |
| `authorizedVisitsUsed` | `orders/authorization-service.ts` | `SCHEDULED` + `IN_PROGRESS` + `COMPLETED`, any date; adds `CANCELLED` for customers configured that way. Used by scheduling enforcement |
| `usedVisitsInWindow` | `orders/authorization-service.ts` | `COMPLETED` only, scheduled inside the authorization window. Shown on the UI badge |
| `deliveredUnits` | `visits/visit-counts.ts`, `orders/authorization-service.ts` | Completed visit *groups* (the pre-pivot "unit"). Shown on the utilization report |
| `billableVisitCount` | `visits/visit-counts.ts` | Completed visits with a signed note |
| `uniqueServiceDates` | `visits/visit-counts.ts` | Distinct calendar days with a completed visit |
| `setProgress` | `visits/visit-counts.ts` | Non-placeholder groups over `expectedVisitCount` |
| `completedVisits` (dashboard) | `reporting/operations-report.ts` | Completed visit *groups*, labeled "completed visits" |
| `visitCount` (revenue) | `reporting/revenue-report.ts` | Completed *visits* with `completedAt` in the window |
| patient header `billable` | `reporting/operations-report.ts` | Completed visits with a signed note and no charge yet |

"Used" against an authorization therefore has three live definitions
(`authorizedVisitsUsed`, `usedVisitsInWindow`, `deliveredUnits`); enforcement
reads the first, the badge the second, and the utilization report the third.

## Price and money terms

| Term | Current meaning |
|---|---|
| Estimate | A pre-service figure. Intake returns 20% of a current-contract rate (`pricing/intake-estimate.ts`); authorization preview uses the cheapest matching rate |
| Contracted rate | A `PayerRate` resolved from the coverage's payer contract. Different paths resolve it differently (see `docs/architecture.md`, Pricing resolution) |
| Billed charge | The amount on a posted `Charge` / `ChargeLine`, priced when the charge was created |
| Claim amount | `Claim.totalAmount`, summed from claim lines at claim creation |
| Allowed / paid amount | The payer-adjudicated amount, arriving on a `RemittanceLine` (`paidAmount`, `adjustmentAmount`, `adjustmentCode`) |
| Patient responsibility | Copay, coinsurance, and deductible from coverage plus any `PR-` adjustments; surfaced on statements |
| Payment | A received `Payment` (usually ERA); carries `unappliedAmount` until applied to claims |
| Expected reimbursement | A live estimate computed at visit completion (`visits/completion-price.ts`); stored only on the emitted event, not on the visit |

Money is represented as `Decimal` in most tables, as integer cents on the
claim-balance side of cash application (`lib/money-cents.ts`), and as JavaScript
numbers in reports. Rounding has three strategies (`pricing/rounding.ts`): per
unit, on the final total, and to whole dollars for one customer's statements.

## Revenue definitions

"Revenue" resolves to different numbers by report:

| Source | Definition |
|---|---|
| Operations dashboard | Sum of `Claim.totalAmount` for claims *created* in the window |
| Revenue report | Posted charge amount where present, else the contract rate effective *today*, grouped by set service type |
| Month close | Recognized revenue re-derived from operational tables and current rates at run time |
| Financial postings | The subset of financial facts written to `FinancialPosting` (partially adopted) |

## Claim, AR, and cash terms

| Term | Current meaning |
|---|---|
| Claim status | `DRAFT`, `READY`, `SUBMITTED`, `ACCEPTED`, `REJECTED`, `VOIDED`, `PAID` |
| Claim balance | `Claim.balanceAmount`, stored and decremented by cash application |
| External id | The clearinghouse-assigned id, written on submission acceptance |
| Rejection | A `ClaimRejection` with a payer reason code and category |
| Cash application | A `CashApplication` row linking a payment to a claim; reversal restores balances and deletes the row |
| Unapplied cash | `Payment.unappliedAmount`; reconciled against surviving application rows |
| Receivables | Sum of `balanceAmount` for claims not `PAID`/`VOIDED` (point in time, not period-scoped) |

## Custom-field storage

A single logical "custom field" may live in any of four places, and reporting may
read more than one:

- **JSON columns** — `Patient.customData`, `VisitSet.customData`, `Visit.customData`.
- **EAV tables** — `CustomFieldDefinition` plus `CustomFieldValue` with typed
  columns (`stringValue`, `numberValue`, `dateValue`, `booleanValue`, `jsonValue`).
- **Hard-coded fields** — first-class columns on the entity.
- **Free text** — `Patient.notesText`.

A definition's `dataType` can change after values are written; existing values
keep whatever typed column they were stored in. Reporting resolves EAV values one
query per row.

## Date conventions

- Scheduled date: when service was planned (`scheduledStart` / `scheduledDate`)
- Service date: when the visit occurred (`actualStart`)
- Completion date: when the operational completion action occurred (`completedAt`)
- Documentation date: when a note was signed (`signedAt`)
- Posting date: when a financial fact was recognized (`postingDate`)
- Received date: when cash arrived (`receivedAt`)
- Creation date: when a database record was inserted (`createdAt`)

Reports should document which date they use; the same visit can fall in different
months depending on whether service date or completion date is chosen.

## Known definition conflicts

The following are recorded as observations of current behavior, not as defects.
Each is a place where two screens compute the same metric differently.

- **Completed visits.** The operations dashboard counts completed visit *groups*;
  the revenue report counts completed *visits*. For multi-visit groups the
  dashboard number is lower (see INC-1120).
- **Authorization "used."** Scheduling enforcement, the UI badge, and the
  utilization report each use a different one of `authorizedVisitsUsed`,
  `usedVisitsInWindow`, and `deliveredUnits`.
- **Revenue.** The dashboard, the revenue report, and month close each derive
  revenue from a different source and rate basis (see the Revenue definitions
  table).
- **Documentation status.** Screens that read live `ClinicalNote` rows can
  disagree with screens that read the cached `VisitGroup.documentationStatus`.
- **Active patient.** Some views use the `active` flag; others require a visit in
  the selected period.
- **Price for the same visit.** Estimate, scheduled-display, completion, charge,
  and report paths can each return a different amount for one visit because they
  resolve coverage, date, location, credential modifier, and contract precedence
  differently.
